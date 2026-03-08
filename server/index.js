// ── Global crash handlers — must be first ─────────────────────────
process.on('uncaughtException',  (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  process.exit(1); // Let Docker/PM2 restart cleanly
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  process.exit(1);
});

import 'dotenv/config';
import express          from 'express';
import cors             from 'cors';
import path             from 'path';
import fs               from 'fs/promises';
import { fileURLToPath } from 'url';

// ── Validate required env vars before anything else ───────────────
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}
if (!process.env.MASTER_SECRET) {
  console.error('FATAL: MASTER_SECRET environment variable is not set');
  process.exit(1);
}

import authRoutes               from './routes/auth.js';
import workflowRoutes           from './routes/workflows.js';
import execRoutes               from './routes/exec.js';
import { wfRouter, stepRouter } from './routes/design.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3001;
const DATA_DIR  = process.env.DATA_DIR || './waiflo-data';

// ── Startup: clean up any stale lock files left by a previous crash ──
// proper-lockfile creates a .lock directory; if the process died while
// holding the lock it never gets removed, causing all subsequent writes
// to hang. Even though we've removed proper-lockfile, this guards against
// any residual files from previous deployments.
async function cleanupStaleLocks() {
  const candidates = [
    path.join(DATA_DIR, 'users.json.lock'),
    path.join(DATA_DIR, 'users.json.lock.tmp'),
  ];
  for (const p of candidates) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      console.log(`[startup] removed stale lock: ${p}`);
    } catch { /* nothing to remove */ }
  }
}

await cleanupStaleLocks();

// ── Express ───────────────────────────────────────────────────────
const app = express();

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : true; // Allow all if not configured — set CORS_ORIGIN in production
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Pages ─────────────────────────────────────────────────────────
app.get('/',       (_, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));
app.get('/editor', (_, res) => res.sendFile(path.join(__dirname, '../public/editor.html')));
app.get('/login',  (_, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/docs',   (_, res) => res.sendFile(path.join(__dirname, '../public/docs.html')));

// ── API ───────────────────────────────────────────────────────────
app.use('/api/auth',                 authRoutes);
app.use('/api/workflows',            workflowRoutes);
app.use('/api/exec',                 execRoutes);
app.use('/api/workflow/design',      wfRouter);
app.use('/api/workflow-step/design', stepRouter);
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ── Fallback ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Waiflo server → http://localhost:${PORT}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`MASTER_SECRET: ${process.env.MASTER_SECRET ? 'set ✓' : 'NOT SET ✗'}`);
  console.log(`JWT_SECRET:    ${process.env.JWT_SECRET    ? 'set ✓' : 'NOT SET ✗'}`);
});