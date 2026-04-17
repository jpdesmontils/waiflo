import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseFrames, streamSseFrames } from '../public/js/sse.js';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  // jsdom is optional in constrained environments.
}

function makeTextStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    }
  });
}

test('parseSseFrames supports multi-line data fields', () => {
  const payload = [
    'event: done',
    'data: {"parsed":{"message":"line1\\nline2"}}',
    '',
    ''
  ].join('\n');

  const { frames, remainder } = parseSseFrames(payload);
  assert.equal(remainder, '');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'done');
  assert.equal(frames[0].data.parsed.message, 'line1\nline2');
});

test('executeStep flow marks step as done even if final SSE frame is flushed on close', async (t) => {
  if (!JSDOM) {
    t.skip('jsdom not available in this environment');
    return;
  }
  const dom = new JSDOM('<div id="status">running</div><pre id="output"></pre>');
  const statusEl = dom.window.document.getElementById('status');
  const outputEl = dom.window.document.getElementById('output');

  const chunks = [
    'event: token\ndata: {"text":"hello"}\n\n',
    'event: done\ndata: {"parsed":{"ok":true}}' // no trailing \n\n on purpose
  ];

  let stepState = 'running';
  await streamSseFrames(makeTextStream(chunks), ({ event, data }) => {
    if (event === 'token') {
      outputEl.textContent += data.text || '';
      stepState = 'running';
      statusEl.textContent = 'running';
      return true;
    }
    if (event === 'done') {
      stepState = 'done';
      statusEl.textContent = 'done';
      outputEl.textContent = JSON.stringify(data.parsed ?? null);
      return true;
    }
    if (event === 'error') {
      stepState = 'error';
      statusEl.textContent = 'error';
      return false;
    }
    return true;
  });

  assert.equal(stepState, 'done');
  assert.equal(statusEl.textContent, 'done');
  assert.equal(outputEl.textContent, '{"ok":true}');
});

test('runWorkflowFromHere flow receives last step_finished and workflow_finished from tail flush', async (t) => {
  if (!JSDOM) {
    t.skip('jsdom not available in this environment');
    return;
  }
  const dom = new JSDOM('<div id="wf-status">running</div><pre id="wf-log"></pre>');
  const wfStatusEl = dom.window.document.getElementById('wf-status');
  const wfLogEl = dom.window.document.getElementById('wf-log');

  const chunks = [
    'event: step_started\ndata: {"step_id":"s5","ws_ref":"correlate_ademe_addresses"}\n\n',
    'event: step_finished\ndata: {"step_id":"s5","ws_ref":"correlate_ademe_addresses","status":"done","output":{"final_results":[]}}\n\n',
    'event: workflow_finished\ndata: {"status":"done","last_step":{"step_id":"s5"}}' // no trailing separator
  ];

  let lastStepStatus = 'running';
  let workflowEnded = false;
  await streamSseFrames(makeTextStream(chunks), ({ event, data }) => {
    if (event === 'step_started') {
      lastStepStatus = 'running';
      wfStatusEl.textContent = 'running';
      wfLogEl.textContent += `start:${data.step_id}\n`;
      return true;
    }
    if (event === 'step_finished') {
      lastStepStatus = data.status || 'done';
      wfStatusEl.textContent = data.status || 'done';
      wfLogEl.textContent += `end:${data.step_id}:${data.status}\n`;
      return true;
    }
    if (event === 'workflow_finished') {
      workflowEnded = true;
      wfLogEl.textContent += `workflow:${data.status}\n`;
      return false;
    }
    return true;
  });

  assert.equal(lastStepStatus, 'done');
  assert.equal(wfStatusEl.textContent, 'done');
  assert.equal(workflowEnded, true);
  assert.match(wfLogEl.textContent, /workflow:done/);
});
