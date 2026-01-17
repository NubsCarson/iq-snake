import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import dotenv from 'dotenv';
import iqlabs from 'iqlabs-sdk/src';
import { sendTx } from 'iqlabs-sdk/src/sdk/writer/writer_utils';
import type { Idl } from '@coral-xyz/anchor';
import idl from 'iqlabs-sdk/idl/code_in.json';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Config
const RPC_URL = process.env.SOLANA_RPC_ENDPOINT || 'https://api.devnet.solana.com';
const DB_ROOT_ID = 'iq-snake-game';
const LEADERBOARD_TABLE = 'leaderboard';

// Initialize connection
const connection = new Connection(RPC_URL, 'confirmed');
iqlabs.setRpcUrl(RPC_URL);

// Load keypair for server-side operations (reading is free, writing needs keypair)
let serverKeypair = null;
const keypairPath = process.env.SOLANA_KEYPAIR_PATH || join(homedir(), '.config', 'solana', 'id.json');
if (existsSync(keypairPath)) {
  try {
    const secret = JSON.parse(readFileSync(keypairPath, 'utf8'));
    serverKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    console.log(`Server wallet: ${serverKeypair.publicKey.toBase58()}`);
  } catch (e) {
    console.warn('Could not load keypair, write operations will be disabled');
  }
}

// Get leaderboard (read from chain)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const programId = iqlabs.contract.getProgramId();
    const dbRootId = Buffer.from(DB_ROOT_ID, 'utf8');
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);
    const tableSeed = iqlabs.utils.toSeedBytes(LEADERBOARD_TABLE);
    const tablePda = iqlabs.contract.getTablePda(dbRoot, tableSeed, programId);

    const rows = await iqlabs.reader.readTableRows(tablePda, { limit: 100 });

    // Sort by score descending, take top 10
    const sorted = rows
      .map(row => ({
        name: row.name || 'Anonymous',
        score: parseInt(row.score) || 0,
        timestamp: row.timestamp || Date.now()
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    res.json({ success: true, leaderboard: sorted });
  } catch (error) {
    // Table might not exist yet
    console.log('Leaderboard fetch error (table may not exist yet):', error.message);
    res.json({ success: true, leaderboard: [] });
  }
});

// Submit score (write to chain)
app.post('/api/submit-score', async (req, res) => {
  try {
    if (!serverKeypair) {
      return res.status(500).json({ success: false, error: 'Server keypair not configured' });
    }

    const { name, score } = req.body;

    if (!name || typeof score !== 'number') {
      return res.status(400).json({ success: false, error: 'Name and score required' });
    }

    // Write score to on-chain table
    const dbRootId = Buffer.from(DB_ROOT_ID, 'utf8');
    const tableSeed = iqlabs.utils.toSeedBytes(LEADERBOARD_TABLE);

    const rowData = JSON.stringify({
      name: name.slice(0, 20), // Limit name length
      score: score,
      timestamp: Date.now()
    });

    const signature = await iqlabs.writer.writeRow(
      connection,
      serverKeypair,
      dbRootId,
      tableSeed,
      rowData
    );

    console.log(`Score submitted: ${name} - ${score} (tx: ${signature})`);

    res.json({ success: true, signature });
  } catch (error) {
    console.error('Submit score error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    rpc: RPC_URL,
    wallet: serverKeypair ? serverKeypair.publicKey.toBase58() : 'not configured'
  });
});

// One-time initialization (creates db_root and leaderboard table on-chain)
app.post('/api/init', async (req, res) => {
  try {
    if (!serverKeypair) {
      return res.status(500).json({ success: false, error: 'Server keypair not configured' });
    }

    const programId = iqlabs.contract.getProgramId();
    const builder = iqlabs.contract.createInstructionBuilder(idl as Idl, programId);
    const dbRootId = Buffer.from(DB_ROOT_ID, 'utf8');
    const dbRoot = iqlabs.contract.getDbRootPda(dbRootId, programId);
    const tableSeed = iqlabs.utils.toSeedBytes(LEADERBOARD_TABLE);
    const tablePda = iqlabs.contract.getTablePda(dbRoot, tableSeed, programId);
    const instructionTable = iqlabs.contract.getInstructionTablePda(dbRoot, tableSeed, programId);

    const results: string[] = [];

    // Step 1: Check if db_root exists, create if not
    const rootInfo = await connection.getAccountInfo(dbRoot);
    if (!rootInfo) {
      console.log('Creating db_root...');
      const ix = iqlabs.contract.initializeDbRootInstruction(
        builder,
        {
          db_root: dbRoot,
          signer: serverKeypair.publicKey,
          system_program: SystemProgram.programId,
        },
        { db_root_id: dbRootId }
      );
      const sig = await sendTx(connection, serverKeypair, ix);
      results.push(`db_root created: ${sig}`);
      console.log(`db_root created: ${sig}`);
    } else {
      results.push('db_root already exists');
      console.log('db_root already exists');
    }

    // Step 2: Check if table exists, create if not
    const tableInfo = await connection.getAccountInfo(tablePda);
    if (!tableInfo) {
      console.log('Creating leaderboard table...');
      const ix = iqlabs.contract.createTableInstruction(
        builder,
        {
          db_root: dbRoot,
          receiver: new PublicKey(iqlabs.constants.DEFAULT_WRITE_FEE_RECEIVER),
          signer: serverKeypair.publicKey,
          table: tablePda,
          instruction_table: instructionTable,
          system_program: SystemProgram.programId,
        },
        {
          db_root_id: dbRootId,
          table_seed: Buffer.from(tableSeed),
          table_name: Buffer.from(LEADERBOARD_TABLE, 'utf8'),
          column_names: [
            Buffer.from('name', 'utf8'),
            Buffer.from('score', 'utf8'),
            Buffer.from('timestamp', 'utf8'),
          ],
          id_col: Buffer.from('timestamp', 'utf8'), // Use timestamp as unique id
          ext_keys: [],
          gate_mint_opt: null,
          writers_opt: null, // Anyone can write (server-controlled)
        }
      );
      const sig = await sendTx(connection, serverKeypair, ix);
      results.push(`leaderboard table created: ${sig}`);
      console.log(`leaderboard table created: ${sig}`);
    } else {
      results.push('leaderboard table already exists');
      console.log('leaderboard table already exists');
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Init error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    IQ SNAKE GAME                           ║
║                On-Chain Leaderboard                        ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                  ║
║  RPC: ${RPC_URL.slice(0, 45)}...
║  DB Root: ${DB_ROOT_ID}
╚════════════════════════════════════════════════════════════╝
  `);
});
