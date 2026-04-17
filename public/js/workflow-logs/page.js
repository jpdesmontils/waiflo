import './model.js';
import { mapLogsToWorkflowViews, buildKpis } from './mapper.js';

const state = {
  workflows: [],
  selectedWorkflow: null,
  selectedRunId: null,
  selectedStepId: null,
  filters: {
    search: '',
    date: '',
    status: 'all',
    step: 'all',
    runMode: 'all',
    sort: 'createdAt-desc'
  },
  activeTab: 'summary',
  loading: false,
  error: ''
};

const tabs = [
  ['summary', 'Résumé'],
  ['inputs', 'Inputs'],
  ['output', 'Output'],
  ['logOutput', 'Log output'],
  ['meta', 'Métadonnées'],
  ['raw', 'Raw JSON']
];

function init() {
  applyEditorTheme();
  bindControls();
  enableResizablePanels();
  loadData();
}

function t(key, fallback) {
  return window.LABELS?.[key] || fallback;
}

function bindControls() {
  const controls = {
    workflow: document.getElementById('workflow-select'),
    search: document.getElementById('search-input'),
    date: document.getElementById('date-filter'),
    status: document.getElementById('status-filter'),
    step: document.getElementById('step-filter'),
    runMode: document.getElementById('runmode-filter'),
    sort: document.getElementById('sort-filter')
  };

  controls.search.addEventListener('input', (event) => { state.filters.search = event.target.value.trim().toLowerCase(); render(); });
  controls.date.addEventListener('change', (event) => { state.filters.date = event.target.value; render(); });
  controls.status.addEventListener('change', (event) => { state.filters.status = event.target.value; render(); });
  controls.step.addEventListener('change', (event) => { state.filters.step = event.target.value; render(); });
  controls.runMode.addEventListener('change', (event) => { state.filters.runMode = event.target.value; render(); });
  controls.sort.addEventListener('change', (event) => { state.filters.sort = event.target.value; render(); });
  controls.workflow.addEventListener('change', (event) => {
    state.selectedWorkflow = event.target.value;
    state.selectedRunId = null;
    state.selectedStepId = null;
    refreshOptionFilters();
    render();
  });
  document.getElementById('refresh-btn').addEventListener('click', loadData);
  document.getElementById('clear-logs-btn').addEventListener('click', onClearLogsClick);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (event) => {
    if (event.target === document.getElementById('modal-overlay')) closeModal();
  });
}

async function loadData() {
  state.loading = true;
  state.error = '';
  renderStates();

  try {
    const workflowQuery = state.selectedWorkflow ? `?workflow=${encodeURIComponent(state.selectedWorkflow)}` : '';
    const response = await fetch(`/api/exec/history/logs${workflowQuery}`, { credentials: 'include' });
    if (!response.ok) throw new Error(`Unable to load logs (${response.status})`);
    const payload = await response.json();
    state.workflows = mapLogsToWorkflowViews(payload.logs || []);
    state.selectedWorkflow = state.selectedWorkflow || state.workflows[0]?.workflowName || null;
    refreshOptionFilters();
    ensureActiveSelection();
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Unknown load error';
  } finally {
    state.loading = false;
    render();
  }
}

function refreshOptionFilters() {
  const wf = getSelectedWorkflow();
  const steps = new Set();
  const statuses = new Set();
  const runModes = new Set();
  (wf?.runs || []).forEach((run) => {
    runModes.add(run.runMode);
    statuses.add(run.status);
    run.steps.forEach((step) => {
      steps.add(step.stepName);
      statuses.add(step.status);
    });
  });

  fillSelect('status-filter', ['all', ...statuses]);
  fillSelect('step-filter', ['all', ...steps]);
  fillSelect('runmode-filter', ['all', ...runModes]);
  fillSelect('workflow-select', state.workflows.map((it) => it.workflowName), state.selectedWorkflow);
}

function fillSelect(id, values, selectedValue = null) {
  const select = document.getElementById(id);
  if (!values.length) values = ['all'];
  const previous = selectedValue ?? state.filters[id.replace('-filter', '')] ?? 'all';
  select.innerHTML = values.map((value) => `<option value="${value}">${value}</option>`).join('');
  select.value = values.includes(previous) ? previous : values[0];
  if (id.endsWith('-filter')) {
    const key = id.replace('-filter', '');
    if (key in state.filters) state.filters[key] = select.value;
    if (key === 'runmode') state.filters.runMode = select.value;
  }
}

function getSelectedWorkflow() {
  return state.workflows.find((wf) => wf.workflowName === state.selectedWorkflow) || null;
}

function filteredRuns() {
  const wf = getSelectedWorkflow();
  let runs = (wf?.runs || []).slice();
  const { search, date, status, step, runMode, sort } = state.filters;

  runs = runs.filter((run) => {
    const matchesSearch = !search || [
      run.workflowName,
      run.status,
      run.runMode,
      ...run.steps.map((s) => `${s.stepName} ${s.nodeId} ${s.status}`)
    ].join(' ').toLowerCase().includes(search);

    const runDate = run.createdAt.slice(0, 10);
    const matchesDate = !date || runDate === date;
    const matchesStatus = status === 'all' || run.status === status || run.steps.some((s) => s.status === status);
    const matchesStep = step === 'all' || run.steps.some((s) => s.stepName === step);
    const matchesRunMode = runMode === 'all' || run.runMode === runMode;
    return matchesSearch && matchesDate && matchesStatus && matchesStep && matchesRunMode;
  });

  const [sortKey, sortDir] = sort.split('-');
  runs.sort((a, b) => {
    const av = sortKey === 'durationMs' ? (a.durationMs ?? -1) : new Date(a.createdAt).getTime();
    const bv = sortKey === 'durationMs' ? (b.durationMs ?? -1) : new Date(b.createdAt).getTime();
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  return runs;
}

function ensureActiveSelection() {
  const runs = filteredRuns();
  if (!runs.length) {
    state.selectedRunId = null;
    state.selectedStepId = null;
    return;
  }
  if (!runs.some((run) => run.id === state.selectedRunId)) state.selectedRunId = runs[0].id;
  const run = runs.find((it) => it.id === state.selectedRunId);
  if (!run.steps.some((step) => step.id === state.selectedStepId)) state.selectedStepId = run.steps[0]?.id || null;
}

function render() {
  ensureActiveSelection();
  renderStates();
  renderKpis();
  renderRuns();
  renderSteps();
  renderTabs();
  renderDetail();
}

function renderStates() {
  const msg = state.loading ? 'Loading…' : state.error ? `Error: ${state.error}` : '';
  ['runs-state', 'steps-state'].forEach((id) => {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.toggle('visible', Boolean(msg));
  });
}

function renderKpis() {
  const kpis = buildKpis(filteredRuns());
  document.getElementById('kpi-executions').textContent = String(kpis.executions);
  document.getElementById('kpi-success').textContent = `${kpis.successRate}%`;
  document.getElementById('kpi-duration').textContent = `${kpis.avgDuration} ms`;
  document.getElementById('kpi-last-error').textContent = kpis.lastError;
}

function renderRuns() {
  const runs = filteredRuns();
  const container = document.getElementById('runs-container');
  if (!runs.length) {
    container.innerHTML = '<div class="detail">No execution matches the current filters.</div>';
    return;
  }

  container.innerHTML = `
    <table class="table">
      <thead><tr>
        <th>Date/heure</th><th>Statut</th><th>Steps</th><th>Dernier step</th><th>Durée</th><th>runMode</th><th>${escapeHtml(t('label_caller_ip', 'Client IP'))}</th>
      </tr></thead>
      <tbody>
        ${runs.map((run) => `
          <tr data-run-id="${run.id}" class="${state.selectedRunId === run.id ? 'active' : ''}">
            <td>${new Date(run.createdAt).toLocaleString()}</td>
            <td>${statusBadge(run.status)}</td>
            <td>${run.stepsCount}</td>
            <td>${run.lastStep}</td>
            <td>${run.durationMs ?? '—'} ms</td>
            <td><span class="badge info">${run.runMode}</span></td>
            <td>${escapeHtml(maskIp(run.callerIp || '')) || '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  container.querySelectorAll('tr[data-run-id]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedRunId = row.dataset.runId;
      state.selectedStepId = null;
      render();
    });
  });
}

function renderSteps() {
  const run = filteredRuns().find((it) => it.id === state.selectedRunId);
  const container = document.getElementById('steps-container');
  if (!run) {
    container.innerHTML = '<div class="detail">Sélectionnez une exécution pour afficher les steps.</div>';
    return;
  }

  container.innerHTML = `<div class="steps-list">
    ${run.steps.map((step) => `
      <article class="step-item ${state.selectedStepId === step.id ? 'active' : ''}" data-step-id="${step.id}">
        <div class="step-index">${step.order}</div>
        <div class="step-main">
          <div class="step-top">
            <span class="step-name">${step.stepName}</span>
            <span class="badge info">${step.wsType}</span>
            ${statusBadge(step.status)}
          </div>
          <div class="step-meta">${step.nodeId} • ${new Date(step.createdAt).toLocaleString()}</div>
        </div>
        <div class="timeline-dot">●</div>
      </article>
    `).join('')}
  </div>`;

  container.querySelectorAll('.step-item').forEach((node) => {
    node.addEventListener('click', () => {
      state.selectedStepId = node.dataset.stepId;
      renderDetail();
      renderSteps();
    });
  });
}

function renderTabs() {
  const tabsNode = document.getElementById('detail-tabs');
  tabsNode.innerHTML = tabs.map(([id, label]) => `<button class="tab ${state.activeTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('');
  tabsNode.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      renderDetail();
      renderTabs();
    });
  });
}

function renderDetail() {
  const run = filteredRuns().find((it) => it.id === state.selectedRunId);
  const step = run?.steps.find((it) => it.id === state.selectedStepId);
  const container = document.getElementById('detail-container');
  if (!step) {
    container.innerHTML = '<div class="detail">Sélectionnez un step pour afficher les données.</div>';
    return;
  }

  const raw = step.raw;
  const views = {
    summary: renderSummary(raw),
    inputs: renderInputs(raw.inputs),
    output: `<div class="detail">${jsonTree(raw.output)}</div>`,
    logOutput: `<div class="detail"><div class="block">${escapeHtml(prettyMaybeJson(raw.logOutput))}</div></div>`,
    meta: `<div class="detail"><div class="block">${escapeHtml(JSON.stringify(raw.logMeta, null, 2))}</div></div>`,
    raw: `<div class="detail"><button class="copy-btn" id="copy-raw">Copy raw</button><div class="block" id="monaco-host">${escapeHtml(JSON.stringify(raw, null, 2))}</div></div>`
  };

  container.innerHTML = views[state.activeTab] || views.summary;

  if (state.activeTab === 'raw') {
    document.getElementById('copy-raw').addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
    });
    mountMonacoIfAvailable(raw);
  }
}

function renderInputs(inputs) {
  const pretty = escapeHtml(JSON.stringify(inputs, null, 2));
  const urls = extractUrls(inputs).filter((url) => /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(url));
  const links = urls.length
    ? `<div class="kv-grid">${urls.map((url) => `<article class="kv-item"><h4>Image URL</h4><p><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></p></article>`).join('')}</div>`
    : '';
  return `<div class="detail">${links}<div class="block">${pretty}</div></div>`;
}

function renderSummary(raw) {
  const fields = [
    ['Workflow', raw.workflowName],
    ['Step', raw.stepName],
    ['Node', raw.nodeId],
    ['Type', raw.wsType],
    ['Run mode', raw.runMode],
    [t('label_caller_ip', 'Client IP'), maskIp(raw.callerIp || '') || '—'],
    ['Status', raw.status],
    ['Created at', new Date(raw.createdAt).toLocaleString()],
    ['Prompt', raw.prompt]
  ];

  return `<div class="detail"><div class="kv-grid">${fields.map(([k, v]) => `<article class="kv-item"><h4>${k}</h4><p>${escapeHtml(String(v ?? '—'))}</p></article>`).join('')}</div></div>`;
}

function applyEditorTheme() {
  if (localStorage.getItem('wf_theme') === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }
}

function maskIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return '';
  if (ip.length <= 3) return '***';
  return `${ip.slice(0, -3)}***`;
}

function openConfirmModal({ title, message, warning, onConfirm }) {
  const overlay = document.getElementById('modal-overlay');
  const titleNode = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const actions = document.getElementById('modal-actions');

  titleNode.textContent = title;
  body.innerHTML = `<p class="confirm-text">${escapeHtml(message)}</p><p class="confirm-sub">${escapeHtml(warning)}</p>`;
  actions.innerHTML = `
    <button class="modal-btn" id="modal-cancel">${escapeHtml(t('modal_cancel', 'Cancel'))}</button>
    <button class="modal-btn danger" id="modal-confirm">${escapeHtml(t('modal_confirm_delete', 'Delete'))}</button>
  `;

  actions.querySelector('#modal-cancel').addEventListener('click', closeModal);
  actions.querySelector('#modal-confirm').addEventListener('click', async () => {
    closeModal();
    await onConfirm();
  });

  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function showBanner(message, tone = 'ok') {
  const banner = document.getElementById('action-banner');
  banner.className = '';
  banner.classList.add(tone === 'err' ? 'err' : 'ok');
  banner.textContent = message;
  setTimeout(() => banner.classList.add('hidden'), 7000);
}

async function onClearLogsClick() {
  openConfirmModal({
    title: t('modal_clear_logs_title', 'Confirm log cleanup'),
    message: t('modal_clear_logs_message', 'Do you want to delete all log files for the current user?'),
    warning: t('modal_clear_logs_warning', 'This action cannot be undone.'),
    onConfirm: clearLogs
  });
}

async function clearLogs() {
  try {
    const response = await fetch('/api/exec/history/logs', {
      method: 'DELETE',
      credentials: 'include'
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

    const details = payload?.details || {};
    const deletedFiles = Number(details.deletedFiles || 0);
    const deletedDirs = Number(details.deletedDirs || 0);
    const failedCount = Array.isArray(details.failed) ? details.failed.length : 0;
    const successMsg = t('banner_logs_cleared', 'Cleanup complete: {deletedFiles} file(s) deleted, {deletedDirs} folder(s) deleted.')
      .replace('{deletedFiles}', String(deletedFiles))
      .replace('{deletedDirs}', String(deletedDirs));
    showBanner(successMsg, failedCount ? 'err' : 'ok');

    if (failedCount) {
      const failedMsg = t('banner_logs_clear_failed', 'Cleanup finished with errors: {failedCount} failure(s).')
        .replace('{failedCount}', String(failedCount));
      console.error('[workflow-logs] clear logs failures:', details.failed);
      showBanner(`${successMsg} ${failedMsg}`, 'err');
    }
    await loadData();
  } catch (error) {
    showBanner(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'err');
  }
}

function statusBadge(status) {
  const cls = status === 'success' ? 'success' : status === 'error' ? 'error' : status === 'running' ? 'running' : 'info';
  return `<span class="badge ${cls}">${status}</span>`;
}

function prettyMaybeJson(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function jsonTree(data) {
  return `<div class="block json-tree">${renderNode(data)}</div>`;
}

function renderNode(value, label = null) {
  if (value === null || typeof value !== 'object') {
    return `<div>${label ? `<strong>${escapeHtml(label)}:</strong> ` : ''}${escapeHtml(String(value))}</div>`;
  }

  if (Array.isArray(value)) {
    return `<details open><summary>${label ? `${escapeHtml(label)}: ` : ''}[${value.length}]</summary>${value.map((v, i) => renderNode(v, String(i))).join('')}</details>`;
  }

  return `<details open><summary>${label ? `${escapeHtml(label)}: ` : ''}{${Object.keys(value).length}}</summary>${Object.entries(value).map(([k, v]) => renderNode(v, k)).join('')}</details>`;
}

async function mountMonacoIfAvailable(raw) {
  const host = document.getElementById('monaco-host');
  try {
    if (!window.require) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/loader.min.js');
    }
    window.require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      host.innerHTML = '';
      window.monaco.editor.create(host, {
        value: JSON.stringify(raw, null, 2),
        language: 'json',
        readOnly: true,
        minimap: { enabled: false },
        fontSize: 12,
        theme: 'vs-dark'
      });
    });
  } catch {
    // fallback block already rendered
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function extractUrls(input) {
  const urls = [];
  const stack = [input];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string' && /^https?:\/\//i.test(current)) {
      urls.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => stack.push(item));
      continue;
    }
    if (current && typeof current === 'object') {
      Object.values(current).forEach((item) => stack.push(item));
    }
  }
  return urls;
}

function enableResizablePanels() {
  const grid = document.getElementById('panels-grid');
  const attach = (dividerId, leftIndex, rightIndex) => {
    const divider = document.getElementById(dividerId);
    divider.addEventListener('mousedown', (downEvent) => {
      downEvent.preventDefault();
      const startX = downEvent.clientX;
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ');
      const leftStart = parseFloat(columns[leftIndex]);
      const rightStart = parseFloat(columns[rightIndex]);

      function onMove(moveEvent) {
        const delta = moveEvent.clientX - startX;
        const left = Math.max(260, leftStart + delta);
        const right = Math.max(280, rightStart - delta);
        columns[leftIndex] = `${left}px`;
        columns[rightIndex] = `${right}px`;
        grid.style.gridTemplateColumns = columns.join(' ');
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  };

  attach('divider-left', 0, 2);
  attach('divider-right', 2, 4);
}

init();
