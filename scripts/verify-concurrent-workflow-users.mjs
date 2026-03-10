import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT || 3101);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.resolve('.tmp/test-concurrency-data');

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

async function request(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function register(email, password) {
  return request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

async function main() {
  await fs.rm(DATA_DIR, { recursive: true, force: true });

  const server = spawn('node', ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret',
      MASTER_SECRET: process.env.MASTER_SECRET || 'dev-master-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth();

    // SaaS scenario: one admin account owns the workflow, multiple end-users trigger it.
    const admin = await register('admin.concurrent@example.com', 'Password123!');

    const workflowPayload = {
      ws_version: '1.0',
      ws_name: 'shared-saas-workflow',
      steps: [
        {
          ws_name: 'health-check',
          ws_type: 'api',
          ws_api: {
            method: 'GET',
            url: `${BASE_URL}/api/health`,
            query: {
              endUserId: '{{endUserId}}',
              requestId: '{{requestId}}'
            }
          }
        }
      ]
    };

    await request('/api/workflows/shared-saas-workflow', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: JSON.stringify(workflowPayload)
    });

    const step = workflowPayload.steps[0];
    const concurrentCalls = 10;

    const calls = Array.from({ length: concurrentCalls }, (_, idx) => {
      const requestId = `req-${idx + 1}`;
      const endUserId = `tenant-user-${(idx % 4) + 1}`;
      return request('/api/exec/step', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          step,
          inputs: { endUserId, requestId },
          context: { workflowName: 'shared-saas-workflow', nodeId: 'node-1', runMode: 'workflow' }
        })
      });
    });

    const results = await Promise.all(calls);
    if (results.some(r => !r.ok || !r.result?.ok)) {
      throw new Error('At least one concurrent execution failed');
    }

    const runDir = path.join(
      DATA_DIR,
      'runs',
      admin.userId,
      'shared-saas-workflow',
      'health-check'
    );
    const files = (await fs.readdir(runDir)).filter(f => f.endsWith('.json'));
    if (files.length !== concurrentCalls) {
      throw new Error(`Expected ${concurrentCalls} run files, found ${files.length} (possible collision/overwrite)`);
    }

    const requestIds = new Set();
    for (const file of files) {
      const raw = await fs.readFile(path.join(runDir, file), 'utf8');
      const row = JSON.parse(raw);
      if (row?.inputs?.requestId) requestIds.add(row.inputs.requestId);
    }

    if (requestIds.size !== concurrentCalls) {
      throw new Error(`Expected ${concurrentCalls} unique requestIds in history, got ${requestIds.size}`);
    }

    console.log('\n✅ Concurrent workflow API execution validated for one shared account (SaaS admin workflow).');
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
}

main().catch(err => {
  console.error(`\n❌ Concurrency verification failed: ${err.message}`);
  process.exit(1);
});
