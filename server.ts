import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';
import dotenv from 'dotenv';
import iqlabs from 'iqlabs-sdk/src';
import { sendTx } from 'iqlabs-sdk/src/sdk/writer/writer_utils';
import type { Idl } from '@coral-xyz/anchor';
import idl from 'iqlabs-sdk/idl/code_in.json';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Leaderboard Service - handles all on-chain interactions
// ============================================================================

const sha256 = (input: string): Buffer => createHash('sha256').update(input).digest();

class LeaderboardService {
  readonly connection: Connection;
  readonly signer: Keypair;
  readonly dbRootId: Buffer;
  readonly tableSeed: Buffer;
  readonly programId: PublicKey;
  readonly builder: ReturnType<typeof iqlabs.contract.createInstructionBuilder>;

  private initialized = false;

  constructor(connection: Connection, signer: Keypair, rootId: string, tableName: string) {
    this.connection = connection;
    this.signer = signer;
    this.dbRootId = sha256(rootId);
    this.tableSeed = sha256(tableName);
    this.programId = iqlabs.contract.getProgramId();
    this.builder = iqlabs.contract.createInstructionBuilder(idl as Idl, this.programId);
  }

  private getDbRoot(): PublicKey {
    return iqlabs.contract.getDbRootPda(this.dbRootId, this.programId);
  }

  private getTable(): PublicKey {
    return iqlabs.contract.getTablePda(this.getDbRoot(), this.tableSeed, this.programId);
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const dbRoot = this.getDbRoot();
    const table = this.getTable();
    const instructionTable = iqlabs.contract.getInstructionTablePda(dbRoot, this.tableSeed, this.programId);

    // Create db_root if needed
    const rootInfo = await this.connection.getAccountInfo(dbRoot);
    if (!rootInfo) {
      console.log('Creating db_root...');
      const ix = iqlabs.contract.initializeDbRootInstruction(
        this.builder,
        {
          db_root: dbRoot,
          signer: this.signer.publicKey,
          system_program: SystemProgram.programId,
        },
        { db_root_id: this.dbRootId }
      );
      await sendTx(this.connection, this.signer, ix);
      console.log('db_root created');
    }

    // Create table if needed
    const tableInfo = await this.connection.getAccountInfo(table);
    if (!tableInfo) {
      console.log('Creating leaderboard table...');
      const ix = iqlabs.contract.createTableInstruction(
        this.builder,
        {
          db_root: dbRoot,
          receiver: new PublicKey(iqlabs.constants.DEFAULT_WRITE_FEE_RECEIVER),
          signer: this.signer.publicKey,
          table: table,
          instruction_table: instructionTable,
          system_program: SystemProgram.programId,
        },
        {
          db_root_id: this.dbRootId,
          table_seed: this.tableSeed,
          table_name: Buffer.from('scores', 'utf8'),
          column_names: ['id', 'name', 'score', 'timestamp'].map(c => Buffer.from(c, 'utf8')),
          id_col: Buffer.from('id', 'utf8'),
          ext_keys: [],
          gate_mint_opt: null,
          writers_opt: null,
        }
      );
      await sendTx(this.connection, this.signer, ix);
      console.log('leaderboard table created');
    }

    this.initialized = true;
  }

  async getScores(limit = 10): Promise<Array<{ name: string; score: number; timestamp: number }>> {
    try {
      const rows = await iqlabs.reader.readTableRows(this.getTable(), { limit: 100 });
      return rows
        .map(row => ({
          name: String(row.name || 'Anonymous'),
          score: parseInt(String(row.score)) || 0,
          timestamp: parseInt(String(row.timestamp)) || Date.now()
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  async submitScore(name: string, score: number): Promise<string> {
    await this.ensureInitialized();

    const rowData = JSON.stringify({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.slice(0, 20),
      score,
      timestamp: Date.now()
    });

    return iqlabs.writer.writeRow(
      this.connection,
      this.signer,
      this.dbRootId,
      this.tableSeed,
      rowData
    );
  }
}

// ============================================================================
// Server Setup
// ============================================================================

const RPC_URL = process.env.SOLANA_RPC_ENDPOINT || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');
iqlabs.setRpcUrl(RPC_URL);

// Load keypair
const keypairPath = process.env.SOLANA_KEYPAIR_PATH || join(homedir(), '.config', 'solana', 'id.json');
let leaderboard: LeaderboardService | null = null;
let walletStatus = '';

if (existsSync(keypairPath)) {
  try {
    const secret = JSON.parse(readFileSync(keypairPath, 'utf8'));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    leaderboard = new LeaderboardService(connection, keypair, 'iq-snake-game', 'scores');
    walletStatus = `Wallet: ${keypair.publicKey.toBase58()}`;
  } catch (e) {
    walletStatus = 'Wallet: Failed to load keypair';
  }
} else {
  walletStatus = `Wallet: Not found - score submission disabled
   Create one with: solana-keygen new`;
}

// ============================================================================
// Express Routes
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/leaderboard', async (_req, res) => {
  if (!leaderboard) {
    return res.json({ success: true, leaderboard: [] });
  }
  const scores = await leaderboard.getScores();
  res.json({ success: true, leaderboard: scores });
});

app.post('/api/submit-score', async (req, res) => {
  if (!leaderboard) {
    return res.status(500).json({ success: false, error: 'Server not configured' });
  }

  const { name, score } = req.body;
  if (!name || typeof score !== 'number') {
    return res.status(400).json({ success: false, error: 'Name and score required' });
  }

  try {
    const signature = await leaderboard.submitScore(name, score);
    console.log(`Score: ${name} - ${score}`);
    res.json({ success: true, signature });
  } catch (error: any) {
    console.error('Submit error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    rpc: RPC_URL,
    wallet: leaderboard ? leaderboard.signer.publicKey.toBase58() : 'not configured'
  });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║             IQ SNAKE GAME - On-Chain Leaderboard           ║
╠════════════════════════════════════════════════════════════╣
║   Open in your browser:  http://localhost:${PORT}          ║
╠════════════════════════════════════════════════════════════╣
║                ${walletStatus.padEnd(56)}                  ║
╚════════════════════════════════════════════════════════════╝
  `);
});
