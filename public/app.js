// ═══════════════════════════════════════════════════════════════════
//  WAIFLO EDITOR — app.js  (React Flow edition)
// ═══════════════════════════════════════════════════════════════════
import { createElement as h, useState, useEffect, memo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, Background, Controls, MiniMap,
  Handle, Position, MarkerType,
  useNodesState, useEdgesState, addEdge, applyNodeChanges,
  ReactFlowProvider, useReactFlow
} from '@xyflow/react';
import dagre from 'dagre';
import {
  FIELD_TYPES, NODE_W, NODE_H, TYPE_COLORS,
  DEMO_WORKFLOW, PROVIDER_MODEL_HINTS, PROVIDER_KEY_PLACEHOLDERS
} from './js/constants.js';
import { wfTs, escapeHtml, syntaxHighlight } from './js/utils.js';

// ── STATE ────────────────────────────────────────────────────────
let currentUser    = null;
let guestMode      = false;
let guestWorkflows = [];
let workflows      = [];
let currentWf      = null;
let currentStep    = null;
let rankDir        = 'TB';
let _setGraphData  = null;
let _getNodes      = null;
let _fitView       = null;
let _graphVersion  = 0;
// fullscreen source: 'workflow' | 'step'
let _jfsSource     = null;
let _providersConfig  = {};
let _providerKeyStatus = {};
let _mcpServers = [];
let _lastStepRuns = {};
let _stepRunUiState = {};
let _currentNodeId = null;
let _runController = null;
let _isExecuting = false;
let _runStepDefaultLabel = '▶ Run Step Only';
let _runFlowDefaultLabel = '▶ Run Workflow From Here';
let _edgeDeletePrompt = null;
let _workflowExecLogs = [];
let _activeRunNodeIds = new Set();
let _lastEditorTab = 'edit';
let _logsPanelDrag = null;
const WF_LOGS_PANEL_POS_KEY = 'wf_logs_panel_pos';
let _activeRunEdgeIds = new Set();
// FIX #6 — flag anti-réentrance pour hydrateRunStateFromServer
let _hydratingNodes = new Set();
let _workflowRunId = null;

// ══════════════════════════════════════════════════════════════════
//  REACT FLOW — CUSTOM NODE
// ══════════════════════════════════════════════════════════════════
const StepNode = memo(function StepNode({ data, selected }) {
  const [expanded, setExpanded] = useState(false);
  const s      = data.step || {};
  const wsType = (s.ws_type || 'prompt').toLowerCase();
  const name   = s.ws_name || '—';
  const rawDesc = (s.step_desc || '').trim();
  const desc   = rawDesc.length > 90 ? rawDesc.slice(0,88)+'…' : (rawDesc || '—');
  const llm    = s.ws_llm;

  const llmBadge = llm
    ? h('span',{ className:'rf-llm-badge' }, `${llm.provider||''}·${(llm.model||'').split('-').slice(-1)[0]} t=${llm.temperature??'?'}`)
    : ((wsType==='api'&&s.ws_api)
      ? h('span',{ className:'rf-llm-badge rf-api-badge' }, `HTTP ${s.ws_api?.method||'GET'}`)
      : ((wsType==='webpage'&&(s.ws_webpage?.url||s.ws_api?.url))
        ? h('span',{ className:'rf-llm-badge rf-api-badge' }, 'HTML GET')
        : null));
  const toolsBadge = s.ws_tools?.length
    ? h('span',{ className:'rf-tools-badge' }, `🔧 ${s.ws_tools.length} tool${s.ws_tools.length>1?'s':''}`) : null;

  const inProps = s.ws_inputs_schema?.properties || {};
  const inReq   = s.ws_inputs_schema?.required   || [];
  const outProps= s.ws_output_schema?.properties  || {};
  const outReq  = s.ws_output_schema?.required    || [];
  const schemaRows = (props, req) =>
    Object.keys(props).length
      ? Object.keys(props).map(k => h('div',{ key:k, className:'rf-expand-field' },
          h('span',{ className:'rf-field-name' },k),
          h('span',{ className:'rf-field-type' },props[k].type||''),
          req.includes(k)?h('span',{ className:'rf-field-req' },'req'):null))
      : [h('div',{ key:'_', className:'rf-no-schema' },'—')];

  return h('div',{
    className:`rf-step-node rf-type-border-${wsType}${selected?' selected':''}${data.isRunning?' running':''}`,
    onClick: () => openStepEditor(data.nodeId)
  },
    h(Handle,{ type:'target', position:Position.Top, id:'top' }),
    h(Handle,{ type:'source', position:Position.Bottom, id:'bottom' }),
    h('div',{ className:`rf-card-header${data.isRunning ? ' running' : ''}` },
      h('span',{ className:`rf-type-badge rf-type-${wsType}` },wsType),
      h('span',{ className:'rf-card-name' },name)
    ),
    h('div',{ className:'rf-card-desc' },desc),
    h('div',{ className:'rf-card-meta-row' },llmBadge,toolsBadge),
    h('div',{ className:'rf-card-footer' },
      h('button',{ className:`rf-card-btn rf-btn-expand${expanded?' open':''}`,
        onClick:e=>{ e.stopPropagation(); setExpanded(v=>!v); } }, expanded?'i/o ▴':'i/o ▾'),
      h('button',{ className:'rf-card-btn rf-btn-edit',
        onClick:e=>{ e.stopPropagation(); openStepEditor(data.nodeId); } },'edit'),
      h('button',{ className:'rf-card-btn rf-btn-run',
        onClick:e=>{ e.stopPropagation(); openStepEditor(data.nodeId,'run'); } },'▶')
    ),
    expanded && h('div',{ className:'rf-card-expand' },
      h('div',null, h('div',{ className:'rf-expand-title' },'inputs'), ...schemaRows(inProps,inReq)),
      h('div',null, h('div',{ className:'rf-expand-title' },'outputs'),...schemaRows(outProps,outReq))
    )
  );
});

const nodeTypes = { step: StepNode };

function FlowInner({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onEdgeClick, onPaneClick, onNodeDragStop, version }) {
  const { fitView } = useReactFlow();
  _fitView = fitView;
  useEffect(() => { setTimeout(()=>fitView({ padding:0.12, duration:400 }),60); }, [version]);
  return h(ReactFlow,{
    nodes, edges, onNodesChange, onEdgesChange, onConnect, onEdgeClick, onPaneClick, onNodeDragStop, nodeTypes,
    defaultEdgeOptions:{ type:'smoothstep', markerEnd:{ type:MarkerType.ArrowClosed, color:'#2a3f60' }, style:{ stroke:'#2a3f60', strokeWidth:1.5 } },
    fitView:true, fitViewOptions:{ padding:0.12 },
    minZoom:0.08, maxZoom:2,
    proOptions:{ hideAttribution:true },
    deleteKeyCode:null, selectionKeyCode:null,
    dragHandle:'.rf-card-header'
  },
    h(Background,{ color:'#1a2740', gap:40, size:1, variant:'dots' }),
    h(Controls,{ position:'bottom-right', showInteractive:false }),
    h(MiniMap,{ position:'bottom-left', nodeColor:n=>TYPE_COLORS[n.data?.step?.ws_type]||'#1e3050', maskColor:'rgba(8,12,18,.75)', style:{ background:'#0e1520', border:'1px solid #1a2740', borderRadius:'6px' } })
  );
}

function AppGraph() {
  const [nodes, setNodes] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [version, setVersion] = useState(0);

  const onNodesChange = (changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
    persistWorkflowNodePositions(changes);
  };

  const onNodeDragStop = (_evt, node) => {
    if (!node?.id || !node?.position) return;
    persistWorkflowNodePositions([{
      type: 'position',
      id: node.id,
      position: node.position,
      dragging: false
    }]);
  };

  const onConnect = (params) => {
    setEdges((eds) => addEdge({
      ...params,
      id:`${params.source}->${params.target}`,
      type:'smoothstep'
    }, eds));
    syncWorkflowDependencies(params.source, params.target);
  };

  const onEdgeClick = (evt, edge) => {
    evt?.preventDefault?.();
    evt?.stopPropagation?.();
    showEdgeDeletePrompt(edge, evt?.clientX || 0, evt?.clientY || 0);
  };

  const onPaneClick = () => hideEdgeDeletePrompt();

  _setGraphData = (gd) => { setNodes(gd.nodes); setEdges(gd.edges); setVersion(gd.version); };
  _getNodes     = () => nodes;
  return h(ReactFlowProvider,null,
    h(FlowInner,{ nodes, edges, onNodesChange, onEdgesChange, onConnect, onEdgeClick, onPaneClick, onNodeDragStop, version })
  );
}

// ── dagre layout ─────────────────────────────────────────────────
function computeLayout(nodes, edges, direction) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(()=>({}));
  g.setGraph({ rankdir:direction, nodesep:60, ranksep:100, marginx:40, marginy:40 });
  nodes.forEach(n=>g.setNode(n.id,{ width:NODE_W, height:NODE_H }));
  edges.forEach(e=>g.setEdge(e.source,e.target));
  dagre.layout(g);
  return nodes.map(n=>{ const {x,y}=g.node(n.id); return {...n, position:{ x:x-NODE_W/2, y:y-NODE_H/2 }}; });
}

// ── buildGraph ───────────────────────────────────────────────────
function buildGraph(data) {
  const steps    = data.steps || [];
  const wf       = (data.workflows||[]).find(w=>w.wf_nodes?.length) || null;
  const stepsMap = {};
  steps.forEach(s=>(stepsMap[s.ws_name]=s));
  let rawNodes=[], rawEdges=[];

  if (wf) {
    wf.wf_nodes.forEach(node=>{
      const s = stepsMap[node.ws_ref]||{ ws_name:node.ws_ref, ws_type:'prompt' };
      const nodePos = node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
        ? { x: node.position.x, y: node.position.y }
        : { x: 0, y: 0 };
      rawNodes.push({ id:node.step_id, type:'step', position:nodePos, data:{ step:s, nodeId:node.step_id } });
      (node.depends_on||[]).forEach(dep=>{
        const depNode = findWorkflowNode(wf, dep);
        if (!depNode) return;
        rawEdges.push({ id:`${depNode.step_id}->${node.step_id}`, source:depNode.step_id, target:node.step_id });
      });
    });
    document.getElementById('meta-steps').textContent = wf.wf_nodes.length;
    document.getElementById('meta-wf').textContent    = wf.wf_name||'—';
    document.getElementById('meta-wf-pill').style.display = '';
  } else {
    steps.forEach((s)=>{
      rawNodes.push({ id:s.ws_name, type:'step', position:{x:0,y:0}, data:{ step:s, nodeId:s.ws_name } });
    });
    document.getElementById('meta-steps').textContent = steps.length;
    document.getElementById('meta-wf-pill').style.display = 'none';
  }
  const hasPersistedPositions = wf && rawNodes.some(n => {
    const node = (wf.wf_nodes || []).find(wfn => wfn.step_id === n.id);
    return Number.isFinite(node?.position?.x) && Number.isFinite(node?.position?.y);
  });
  const layoutedNodes = hasPersistedPositions ? rawNodes : computeLayout(rawNodes, rawEdges, rankDir);

  // FIX #4 — initialiser maxY à -Infinity pour gérer les positions négatives
  const curPos = {};
  if (_getNodes) _getNodes().forEach(n => { curPos[n.id] = n.position; });
  let maxY = -Infinity;
  let refX = layoutedNodes[0]?.position?.x ?? 0;
  layoutedNodes.forEach(n => {
    if (curPos[n.id]) {
      maxY = Math.max(maxY, curPos[n.id].y + NODE_H);
      refX = curPos[n.id].x;
    }
  });
  if (maxY === -Infinity) maxY = 0; // fallback si aucun nœud existant

  const finalNodes = layoutedNodes.map(n => {
    const base = curPos[n.id] ? { ...n, position: curPos[n.id] } : (() => {
      const pos = { x: refX, y: maxY + 60 };
      maxY = pos.y + NODE_H;
      return { ...n, position: pos };
    })();
    return {
      ...base,
      data: {
        ...base.data,
        isRunning: _activeRunNodeIds.has(base.id)
      }
    };
  });
  const finalEdges = rawEdges.map(e => ({
    ...e,
    className: _activeRunEdgeIds.has(e.id) ? 'rf-edge-running' : undefined,
    animated: _activeRunEdgeIds.has(e.id)
  }));

  _setWorkflowNameUI(currentWf?.name || data.lang_name || '—');
  document.getElementById('wf-meta').classList.remove('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  _graphVersion++;
  if (_setGraphData) _setGraphData({ nodes:finalNodes, edges:finalEdges, version:_graphVersion });
}

function fitGraph() { _fitView?.({ padding:0.12, duration:400 }); }
function setLayout(dir) { rankDir=dir; if(currentWf) buildGraph(currentWf.data); }

function ensureWorkflowGraph() {
  if (!currentWf) return null;
  const data = currentWf.data;
  if (!Array.isArray(data.workflows)) data.workflows = [];

  let wf = data.workflows.find(w => Array.isArray(w.wf_nodes));
  if (!wf) {
    wf = {
      wf_name: data.lang_name || currentWf.name || 'main',
      wf_nodes: (data.steps || []).map((step, idx) => ({
        step_id: step.ws_name || `step_${idx+1}`,
        ws_ref: step.ws_name,
        depends_on: [],
        position: { x: 0, y: 0 }
      }))
    };
    data.workflows.push(wf);
  }

  if (!Array.isArray(wf.wf_nodes)) wf.wf_nodes = [];
  return wf;
}

function ensureWorkflowNodeForStep(stepName) {
  const wf = ensureWorkflowGraph();
  if (!wf || !stepName) return null;

  let node = wf.wf_nodes.find(n => n.ws_ref === stepName);
  if (node) return node;

  const base = `node_${stepName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  let stepId = base;
  let i = 2;
  while (wf.wf_nodes.some(n => n.step_id === stepId)) {
    stepId = `${base}_${i++}`;
  }

  node = { step_id: stepId, ws_ref: stepName, depends_on: [], position: { x: 0, y: 0 } };
  wf.wf_nodes.push(node);
  return node;
}

function persistWorkflowNodePositions(changes = []) {
  if (!currentWf || !Array.isArray(changes) || !changes.length) return;
  const wf = ensureWorkflowGraph();
  if (!wf) return;

  let updated = false;
  for (const change of changes) {
    if (change?.type !== 'position' || !change?.position || change?.dragging) continue;
    const node = (wf.wf_nodes || []).find(n => n.step_id === change.id);
    if (!node) continue;

    const x = Math.round(change.position.x);
    const y = Math.round(change.position.y);
    if (node.position?.x === x && node.position?.y === y) continue;

    node.position = { x, y };
    updated = true;
  }

  if (!updated) return;
  _refreshWfJsonPanel();
  if (guestMode) _guestSync();
  else saveWorkflow(true);
}

function removeWorkflowDependency(sourceId, targetId) {
  if (!currentWf) return;
  const wf = (currentWf.data.workflows || []).find(w => Array.isArray(w.wf_nodes));
  if (!wf) return;
  const targetNode = (wf.wf_nodes || []).find(n => n.step_id === targetId);
  if (!targetNode) return;
  targetNode.depends_on = (targetNode.depends_on || []).filter(d => d !== sourceId);
  buildGraph(currentWf.data); _refreshWfJsonPanel();
  if (guestMode) _guestSync(); else saveWorkflow();
}

function showEdgeDeletePrompt(edge, x, y) {
  _edgeDeletePrompt = { edge, x, y };
  renderEdgeDeletePrompt();
}

function hideEdgeDeletePrompt() {
  _edgeDeletePrompt = null;
  renderEdgeDeletePrompt();
}

// FIX #8 — clamp le prompt dans le viewport
function renderEdgeDeletePrompt() {
  const el = document.getElementById('edge-delete-prompt');
  if (!el) return;
  if (!_edgeDeletePrompt) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const margin = 8;
  const btnW = 40, btnH = 36;
  const x = Math.min(_edgeDeletePrompt.x, window.innerWidth  - btnW - margin);
  const y = Math.min(_edgeDeletePrompt.y, window.innerHeight - btnH - margin);
  el.style.left = `${Math.max(margin, x)}px`;
  el.style.top  = `${Math.max(margin, y)}px`;
}

function confirmEdgeDelete() {
  if (!_edgeDeletePrompt?.edge) return;
  const { source, target } = _edgeDeletePrompt.edge;
  hideEdgeDeletePrompt();
  openConfirm('Supprimer la dépendance ?', `${source} → ${target}`, () => {
    removeWorkflowDependency(source, target);
    toast('Dépendance supprimée','ok');
  });
}

function syncWorkflowDependencies(sourceId, targetId) {
  const wf = ensureWorkflowGraph();
  if (!wf) return;

  let sourceNode = wf.wf_nodes.find(n => n.step_id === sourceId);
  let targetNode = wf.wf_nodes.find(n => n.step_id === targetId);

  if (!sourceNode) {
    const sourceStep = (currentWf.data.steps || []).find(s => s.ws_name === sourceId);
    if (sourceStep) {
      sourceNode = { step_id: sourceId, ws_ref: sourceStep.ws_name, depends_on: [], position: { x: 0, y: 0 } };
      wf.wf_nodes.push(sourceNode);
    }
  }

  if (!targetNode) {
    const targetStep = (currentWf.data.steps || []).find(s => s.ws_name === targetId);
    if (targetStep) {
      targetNode = { step_id: targetId, ws_ref: targetStep.ws_name, depends_on: [], position: { x: 0, y: 0 } };
      wf.wf_nodes.push(targetNode);
    }
  }

  if (!sourceNode || !targetNode) return;
  if (!Array.isArray(targetNode.depends_on)) targetNode.depends_on = [];
  if (!targetNode.depends_on.includes(sourceNode.step_id)) {
    targetNode.depends_on.push(sourceNode.step_id);
  }

  _refreshWfJsonPanel();
  if (guestMode) _guestSync();
  else saveWorkflow();
}

// ── AUTH / SESSION ────────────────────────────────────────────────
function doLogout() {
  fetch('/api/auth/logout', { method:'POST', credentials:'include' }).catch(() => {});
  currentUser=null; currentWf=null;
  guestMode=false; guestWorkflows=[]; workflows=[];
  window.location.href = '/login';
}

function enterGuestMode(withDemo = true) {
  guestMode = true; currentUser=null;
  document.getElementById('guest-banner').classList.remove('hidden');
  document.getElementById('guest-badge').style.display = '';
  document.getElementById('user-badge').textContent = '';
  document.getElementById('btn-settings').style.display = 'none';
  guestWorkflows = [];
  if (withDemo) {
    guestWorkflows.push({ name:'demo_pipeline', data: DEMO_WORKFLOW, updatedAt: new Date().toISOString() });
  }
  workflows = [];
  loadWorkflowList();
  if (withDemo) {
    setTimeout(()=>{ selectWf('demo_pipeline'); }, 200);
  }
}

function enterAuthUser(user) {
  currentUser = user;
  guestMode = false;
  document.getElementById('guest-banner').classList.add('hidden');
  document.getElementById('guest-badge').style.display = 'none';
  document.getElementById('btn-settings').style.display = '';
  document.getElementById('user-badge').textContent = user.email||'';
  loadProviderKeyStatus();
  loadWorkflowList();
}

function showSignupCTA() {
  openModal('Sauvegarder vos workflows', `
    <div style="text-align:center;padding:8px 0 16px">
      <div style="font-size:32px;margin-bottom:12px">&#x2B21;</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--hi);margin-bottom:8px">Mode invité — données non sauvegardées</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--dim);line-height:1.8">
        Créez un compte gratuit pour persister vos workflows,<br>
        exécuter des steps avec votre clé API, et y accéder depuis partout.
      </div>
    </div>`,
    [
      { label:'Continuer en invité', action:closeModal },
      { label:'Créer un compte →', primary:true, action:()=>{ closeModal(); window.location.href='/login'; } }
    ]
  );
}

function _setWorkflowNameUI(name = '—') {
  const label = document.getElementById('meta-name');
  if (label) label.textContent = name;
  const jsonName = document.getElementById('wf-json-panel-name');
  if (jsonName && currentWf) jsonName.textContent = `${currentWf.name}.waiflo.json`;
}

function _isValidWorkflowName(name) {
  return /^[a-zA-Z0-9_.-]+$/.test(name);
}

function startWorkflowRename(name = currentWf?.name, e) {
  if (e) e.stopPropagation();
  if (!name) return;

  openModal('Renommer le workflow',`
    <div class="form-section">
      <div class="form-label">Nouveau nom du workflow</div>
      <input class="form-input" id="rename-wf-name" placeholder="my_pipeline" value="${name}" style="width:100%">
      <div class="form-hint" style="margin-top:6px">Lettres, chiffres, _, - et . uniquement.</div>
    </div>`,
    [
      { label:'Annuler', action:closeModal },
      { label:'Renommer', primary:true, action:async()=>{
        const input = document.getElementById('rename-wf-name');
        const nextName = input.value.trim();
        if (!nextName || nextName === name) return closeModal();
        if (!_isValidWorkflowName(nextName)) return toast('Use only letters, numbers, _, - and .','err');

        if (guestMode) {
          if (guestWorkflows.some(w => w.name === nextName)) return toast('Name already exists','err');
          const item = guestWorkflows.find(w => w.name === name);
          if (!item) return toast('Workflow not found','err');
          item.name = nextName;
          if (item.data) item.data.lang_name = nextName;
          if (currentWf?.name === name) {
            currentWf.name = nextName;
            if (currentWf.data) currentWf.data.lang_name = nextName;
            _setWorkflowNameUI(nextName);
            _refreshWfJsonPanel();
          }
          renderWorkflowList();
          closeModal();
          toast('Workflow renamed (not persisted)','ok');
          return;
        }

        const res = await api(`/api/workflows/${name}/rename`, 'PATCH', { newName: nextName });
        if (res.error) return toast(res.error, 'err');
        if (currentWf?.name === name) {
          currentWf.name = nextName;
          if (currentWf.data) currentWf.data.lang_name = nextName;
          _setWorkflowNameUI(nextName);
          _refreshWfJsonPanel();
        }
        closeModal();
        await loadWorkflowList();
        toast('Workflow renamed','ok');
      }}
    ]
  );

  setTimeout(()=>{ const i=document.getElementById('rename-wf-name'); if(i){i.focus();i.select();} },100);
}

// ── API CLIENT ───────────────────────────────────────────────────
async function api(path, method='GET', body=null, auth=true) {
  const headers = { 'Content-Type':'application/json' };
  const opts = { method, headers };
  if (auth) opts.credentials = 'include';
  if (body) opts.body = JSON.stringify(body);
  try {
    const res  = await fetch(path,opts);
    const data = await res.json();
    if (res.status===401 && auth) doLogout();
    return data;
  } catch(e) { return { error:e.message }; }
}

// ── WORKFLOW LIST ────────────────────────────────────────────────
async function loadWorkflowList() {
  if (guestMode) {
    workflows = guestWorkflows.map(w=>({ name:w.name, updatedAt:w.updatedAt }));
    renderWorkflowList(); return;
  }
  const list = await api('/api/workflows');
  if (list.error) return toast(list.error,'err');
  workflows = list; renderWorkflowList();
}

function renderWorkflowList() {
  const el = document.getElementById('wf-list');
  el.innerHTML='';
  if (!workflows.length) {
    el.innerHTML='<div style="padding:16px 14px;font-family:JetBrains Mono,monospace;font-size:10px;color:var(--dim)">No workflows yet</div>';
    return;
  }
  workflows.forEach(wf => {
    const item = document.createElement('div');
    item.className = 'wf-item' + (currentWf?.name === wf.name ? ' active' : '');
    const d = new Date(wf.updatedAt);
    item.innerHTML=`
      <span class="wf-item-icon">&#x2B21;</span>
      <div class="wf-item-info">
        <div class="wf-item-name">${wf.name}</div>
        <div class="wf-item-date">${d.toLocaleDateString()} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
      </div>
      <div class="wf-item-actions">
        <button class="wf-icon-btn" title="Copy JSON" onclick="copyWfJsonByName('${wf.name}',event)">&#x2398;</button>
        <button class="wf-icon-btn" title="Rename" onclick="startWorkflowRename('${wf.name}',event)">✎</button>
        <button class="wf-icon-btn" title="Duplicate" onclick="duplicateWorkflow('${wf.name}',event)">⧉</button>
        <button class="wf-icon-btn" title="Delete" onclick="deleteWorkflow('${wf.name}',event)">&#x2715;</button>
      </div>`;
    item.addEventListener('click', ()=>selectWf(wf.name));
    el.appendChild(item);
  });
}

// ── WF SELECTION + JSON PANEL ────────────────────────────────────
async function selectWf(name) { await openWorkflow(name); openWfJsonPanel(name); }

function openWfJsonPanel(name) {
  const data = currentWf?.name===name ? currentWf.data : null;
  if (!data) return;
  document.getElementById('wf-json-panel-name').textContent = name+'.waiflo.json';
  const ta = document.getElementById('wf-json-textarea');
  ta.value = JSON.stringify(data,null,2);
  ta.classList.remove('err');
  document.getElementById('wf-json-err').textContent='';
  document.getElementById('left-inner').classList.add('json-open');
}

function closeWfJson() {
  document.getElementById('left-inner').classList.remove('json-open');
  document.getElementById('wf-json-err').textContent='';
}

function onWfJsonInput() {
  const ta=document.getElementById('wf-json-textarea');
  const errEl=document.getElementById('wf-json-err');
  try { JSON.parse(ta.value); ta.classList.remove('err'); errEl.textContent=''; }
  catch(e) { ta.classList.add('err'); errEl.textContent='✕ '+e.message; }
}

function applyWfJson() {
  if (!currentWf) return;
  const ta=document.getElementById('wf-json-textarea');
  let parsed;
  try { parsed=JSON.parse(ta.value); }
  catch(e) { document.getElementById('wf-json-err').textContent='✕ '+e.message; return; }
  currentWf.data=parsed; buildGraph(parsed);
  if (guestMode) { _guestSync(); toast('Applied (not persisted)','ok'); } else saveWorkflow();
}

async function copyWfJson() {
  if (!currentWf) return;
  await navigator.clipboard.writeText(JSON.stringify(currentWf.data,null,2));
  toast('JSON copied','ok');
}

async function copyWfJsonByName(name,e) {
  e.stopPropagation();
  let data;
  if (currentWf?.name===name) { data=currentWf.data; }
  else if (guestMode) { data=guestWorkflows.find(w=>w.name===name)?.data; }
  else { const r=await api(`/api/workflows/${name}`); if(r.error) return toast(r.error,'err'); data=r; }
  if (!data) return toast('Not found','err');
  await navigator.clipboard.writeText(JSON.stringify(data,null,2));
  toast('JSON copied','ok');
}

function _refreshWfJsonPanel() {
  if (!document.getElementById('left-inner').classList.contains('json-open')||!currentWf) return;
  const ta=document.getElementById('wf-json-textarea');
  ta.value=JSON.stringify(currentWf.data,null,2);
  ta.classList.remove('err');
  document.getElementById('wf-json-err').textContent='';
}

// ── JSON FULLSCREEN ──────────────────────────────────────────────
function openJsonFullscreen(source) {
  _jfsSource = source;
  const overlay = document.getElementById('json-fullscreen');
  const ta      = document.getElementById('json-fullscreen-textarea');
  const name    = document.getElementById('json-fullscreen-name');
  const applyBtn= document.getElementById('jfs-apply-btn');
  const errEl   = document.getElementById('json-fullscreen-err');

  if (source === 'workflow') {
    if (!currentWf) return;
    name.textContent = currentWf.name+'.waiflo.json';
    ta.value = JSON.stringify(currentWf.data,null,2);
    applyBtn.style.display = '';
  } else {
    // FIX #3 — vérifier null explicitement avant d'utiliser le résultat
    const s = currentStep || collectStep();
    if (!s) { toast('Aucun step à afficher','err'); return; }
    name.textContent = (s.ws_name||'step')+' — JSON view';
    ta.value = JSON.stringify(s,null,2);
    applyBtn.style.display = 'none';
  }
  ta.classList.remove('err');
  errEl.textContent = '';
  overlay.classList.remove('hidden');
  setTimeout(()=>ta.focus(),50);
}

function closeJsonFullscreen() {
  document.getElementById('json-fullscreen').classList.add('hidden');
  _jfsSource = null;
}

function jfsValidate() {
  if (typeof _jfsSource === 'string' && _jfsSource.startsWith('textarea:')) return;
  const ta=document.getElementById('json-fullscreen-textarea');
  const errEl=document.getElementById('json-fullscreen-err');
  try { JSON.parse(ta.value); ta.classList.remove('err'); errEl.textContent=''; }
  catch(e) { ta.classList.add('err'); errEl.textContent='✕ '+e.message; }
}

async function jfsCopy() {
  const ta=document.getElementById('json-fullscreen-textarea');
  await navigator.clipboard.writeText(ta.value);
  toast('JSON copied','ok');
}

function jfsApply() {
  const fsTa = document.getElementById('json-fullscreen-textarea');
  if (typeof _jfsSource === 'string' && _jfsSource.startsWith('textarea:')) {
    const targetId = _jfsSource.slice('textarea:'.length);
    const target = document.getElementById(targetId);
    if (target) target.value = fsTa.value;
    closeJsonFullscreen();
    return;
  }
  if (_jfsSource!=='workflow'||!currentWf) return;
  let parsed;
  try { parsed=JSON.parse(fsTa.value); }
  catch(e) { document.getElementById('json-fullscreen-err').textContent='✕ '+e.message; return; }
  currentWf.data=parsed; buildGraph(parsed); _refreshWfJsonPanel();
  if (guestMode) { _guestSync(); toast('Applied (not persisted)','ok'); } else saveWorkflow();
  closeJsonFullscreen();
}

// ── WORKFLOW CRUD ────────────────────────────────────────────────
async function openWorkflow(name) {
  let data;
  if (guestMode) {
    const entry=guestWorkflows.find(w=>w.name===name);
    if (!entry) return toast('Workflow not found','err');
    data=entry.data;
  } else {
    data=await api(`/api/workflows/${name}`);
    if (data.error) return toast(data.error,'err');
  }
  currentWf={name,data};
  _lastStepRuns = {};
  _stepRunUiState = {};
  _hydratingNodes = new Set();
  _runController = null;
  _isExecuting = false;
  setExecutionUiState(false);
  closeEditor(); buildGraph(data); renderWorkflowList();
  document.getElementById('btn-save').style.display='';
  document.getElementById('btn-download').style.display='';
  document.getElementById('btn-add-step').style.display='';
}

async function saveWorkflow(silent = false) {
  if (!currentWf) return;
  if (guestMode) { showSignupCTA(); return; }
  const res=await api(`/api/workflows/${currentWf.name}`,'PUT',currentWf.data);
  if (res.error) return toast(res.error,'err');
  if (!silent) toast('Saved','ok');
  loadWorkflowList();
}

function _guestSync() {
  if (!currentWf) return;
  const idx=guestWorkflows.findIndex(w=>w.name===currentWf.name);
  if (idx>=0) { guestWorkflows[idx].data=currentWf.data; guestWorkflows[idx].updatedAt=new Date().toISOString(); }
}

function downloadWorkflow() {
  if (!currentWf) return;
  const blob=new Blob([JSON.stringify(currentWf.data,null,2)],{ type:'application/json' });
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=`${currentWf.name}.waiflo.json`; a.click();
}

function newWorkflow() {
  openModal('New Workflow',`
    <div class="form-section">
      <div class="form-label">Workflow Name</div>
      <input class="form-input" id="new-wf-name" placeholder="my_pipeline" style="width:100%">
      <div class="form-hint" style="margin-top:6px">Lowercase, underscores only.</div>
    </div>`,
    [
      { label:'Cancel', action:closeModal },
      { label:'Create', primary:true, action:async()=>{
        const name=document.getElementById('new-wf-name').value.trim();
        if (!name) return;
        const data={ lang_name:name, steps:[], workflows:[] };
        if (guestMode) {
          if (guestWorkflows.find(w=>w.name===name)) return toast('Name already exists','err');
          guestWorkflows.push({ name,data,updatedAt:new Date().toISOString() });
          closeModal(); await loadWorkflowList(); selectWf(name);
        } else {
          const res=await api(`/api/workflows/${name}`,'POST',data);
          if (res.error) return toast(res.error,'err');
          closeModal(); await loadWorkflowList(); selectWf(name);
        }
      }}
    ]
  );
  setTimeout(()=>document.getElementById('new-wf-name')?.focus(),100);
}

function duplicateWorkflow(sourceName = currentWf?.name, e) {
  if (e) e.stopPropagation();
  if (!sourceName) return;
  const source = sourceName === currentWf?.name ? currentWf : (guestMode ? guestWorkflows.find(w => w.name === sourceName) : null);
  if (!source && guestMode) return toast('Workflow not found','err');

  const suggestedName = sourceName.replace(/_copy(_\d+)?$/, '') + '_copy';
  openModal('Dupliquer le workflow',`
    <div class="form-section">
      <div class="form-label">Nom du nouveau workflow</div>
      <input class="form-input" id="dup-wf-name" placeholder="my_pipeline_copy" value="${suggestedName}" style="width:100%">
      <div class="form-hint" style="margin-top:6px">Minuscules, chiffres, _ et - uniquement.</div>
    </div>`,
    [
      { label:'Annuler', action:closeModal },
      { label:'Dupliquer', primary:true, action:async()=>{
        const name = document.getElementById('dup-wf-name').value.trim();
        if (!name) return;
        if (!_isValidWorkflowName(name)) return toast('Use only letters, numbers, _, - and .','err');
        let sourceData = currentWf?.name === sourceName ? currentWf.data : source?.data;
        if (!sourceData && !guestMode) {
          const fetched = await api(`/api/workflows/${sourceName}`);
          if (fetched.error) return toast(fetched.error,'err');
          sourceData = fetched;
        }
        if (!sourceData) return toast('Workflow not found','err');
        const data = JSON.parse(JSON.stringify(sourceData));
        data.lang_name = name;
        if (guestMode) {
          if (guestWorkflows.find(w=>w.name===name)) return toast('Name already exists','err');
          guestWorkflows.push({ name, data, updatedAt:new Date().toISOString() });
          closeModal(); await loadWorkflowList(); selectWf(name); toast('Workflow dupliqué (non persisté)','ok');
        } else {
          const res = await api(`/api/workflows/${name}`,'POST',data);
          if (res.error) return toast(res.error,'err');
          closeModal(); await loadWorkflowList(); selectWf(name); toast('Workflow dupliqué','ok');
        }
      }}
    ]
  );
  setTimeout(()=>{ const i=document.getElementById('dup-wf-name'); if(i){i.focus();i.select();} },100);
}

function importWorkflow() {
  const input=document.createElement('input');
  input.type='file'; input.accept='.json,.waiflo';
  input.onchange=async e=>{
    const file=e.target.files[0]; if (!file) return;
    const text=await file.text();
    try {
      const data=JSON.parse(text);
      const name=file.name.replace('.waiflo.json','').replace('.json','');
      if (guestMode) {
        const idx=guestWorkflows.findIndex(w=>w.name===name);
        if (idx>=0) guestWorkflows[idx]={ name,data,updatedAt:new Date().toISOString() };
        else guestWorkflows.push({ name,data,updatedAt:new Date().toISOString() });
        await loadWorkflowList(); selectWf(name); toast('Imported (not saved)','ok');
      } else {
        const res=await api(`/api/workflows/${name}`,'POST',data);
        if (res.error) return toast(res.error,'err');
        await loadWorkflowList(); selectWf(name); toast('Imported','ok');
      }
    } catch(err) { toast('Invalid JSON: '+err.message,'err'); }
  };
  input.click();
}

function deleteWorkflow(name,e) {
  e.stopPropagation();
  openConfirm(`Delete "${name}"?`,'This action cannot be undone.',async()=>{
    if (guestMode) { guestWorkflows=guestWorkflows.filter(w=>w.name!==name); }
    else { const res=await api(`/api/workflows/${name}`,'DELETE'); if(res.error) return toast(res.error,'err'); }
    if (currentWf?.name===name) {
      currentWf=null;
      if (_setGraphData) _setGraphData({ nodes:[], edges:[], version:++_graphVersion });
      document.getElementById('empty-state').classList.remove('hidden');
      ['btn-save','btn-download','btn-add-step'].forEach(id=>document.getElementById(id).style.display='none');
      document.getElementById('wf-meta').classList.add('hidden');
      closeEditor(); closeWfJson();
    }
    closeModal(); loadWorkflowList(); toast('Deleted','ok');
  });
}

// ── LEFT TOGGLE ──────────────────────────────────────────────────
function toggleLeft() {
  const p=document.getElementById('left-panel');
  const col=p.classList.toggle('collapsed');
  document.getElementById('btn-toggle-left').textContent=col?'›':'‹';
  setTimeout(()=>fitGraph(),280);
}

// ── THEME ────────────────────────────────────────────────────────
function toggleTheme() {
  const light=document.documentElement.classList.toggle('light');
  document.getElementById('btn-theme').textContent=light?'☾':'☀';
  localStorage.setItem('wf_theme',light?'light':'dark');
}

// ── STEP EDITOR ──────────────────────────────────────────────────
function openStepEditor(nodeId, tab=null) {
  if (!currentWf) return;
  const steps=currentWf.data.steps||[];
  let step=steps.find(s=>s.ws_name===nodeId);
  let resolvedNodeId = step ? nodeId : null;
  if (!step) {
    const wf=(currentWf.data.workflows||[]).find(w=>w.wf_nodes?.length);
    if (wf) {
      const node=wf.wf_nodes.find(n=>n.step_id===nodeId);
      if(node) {
        step=steps.find(s=>s.ws_name===node.ws_ref);
        resolvedNodeId = node.step_id;
      }
    }
  }
  if (!step) return;
  currentStep=step;
  // FIX #1 — affecter _currentNodeId AVANT populateEditor
  // pour que updateRunTab/getStepRunState reçoivent le bon nodeId
  _currentNodeId = resolvedNodeId || step.ws_name;
  populateEditor(currentStep);
  setRightPanelVisible(true);
  switchEditorTab(tab || _lastEditorTab || 'edit');
}

function openNewStepEditor() {
  currentStep=null;
  _currentNodeId = null;
  populateEditor({ ws_name:'',ws_type:'prompt', ws_llm:{ provider:'anthropic',model:'claude-sonnet-4-20250514',temperature:0 }, ws_inputs_schema:{ type:'object',required:[],properties:{} }, ws_output_schema:{ type:'object',required:[],properties:{} } });
  setRightPanelVisible(true);
  switchEditorTab('edit');
}

function formatJsonForEditor(value) {
  if (value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return ''; }
}

function parseJsonEditorField(fieldId, label) {
  const raw = document.getElementById(fieldId)?.value?.trim() || '';
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    toast(`${label} must be valid JSON: ${err.message}`,'err');
    return null;
  }
}

function populateEditor(s) {
  document.getElementById('f-name').value      = s.ws_name||'';
  document.getElementById('f-step-desc').value = s.step_desc||'';
  document.getElementById('f-type').value      = s.ws_type||'prompt';
  document.getElementById('f-provider').value  = s.ws_llm?.provider||'anthropic';
  document.getElementById('f-temp').value      = s.ws_llm?.temperature??0;
  onProviderChange(s.ws_llm?.model||'');
  document.getElementById('f-sysprompt').value = s.ws_system_prompt||'';
  document.getElementById('f-template').value  = s.ws_prompt_template||'';
  document.getElementById('f-method').value    = s.ws_api?.method||'GET';
  document.getElementById('f-url').value       = s.ws_webpage?.url || s.ws_api?.url || '';
  document.getElementById('f-api-headers').value = formatJsonForEditor(s.ws_api?.headers || s.ws_webpage?.headers);
  document.getElementById('f-api-query').value   = formatJsonForEditor(s.ws_api?.query);
  document.getElementById('f-api-body').value    = formatJsonForEditor(s.ws_api?.body);
  document.getElementById('f-webpage-mode').value = s.ws_webpage?.mode || 'http';
  document.getElementById('f-webpage-browser-options').value = formatJsonForEditor({
    waitUntil: s.ws_webpage?.waitUntil,
    timeoutMs: s.ws_webpage?.timeoutMs,
    waitForSelector: s.ws_webpage?.waitForSelector,
    viewport: s.ws_webpage?.viewport,
    userAgent: s.ws_webpage?.userAgent
  });
  populateToolServerSelect(s.ws_tool?.mcp_server_label || '');
  onToolMcpServerChange(s.ws_tool?.tool_name || '');

  const apiAdv = document.getElementById('api-advanced-content');
  const apiAdvBtn = document.getElementById('api-advanced-toggle');
  const hasApiAdvancedValues = Boolean((s.ws_api?.headers && Object.keys(s.ws_api.headers).length) || (s.ws_api?.query && Object.keys(s.ws_api.query).length) || s.ws_api?.body != null || (s.ws_webpage?.headers && Object.keys(s.ws_webpage.headers).length) || s.ws_webpage?.waitUntil || s.ws_webpage?.timeoutMs || s.ws_webpage?.waitForSelector || s.ws_webpage?.viewport || s.ws_webpage?.userAgent);
  if (apiAdv && apiAdvBtn) {
    apiAdv.classList.toggle('collapsed', !hasApiAdvancedValues);
    apiAdvBtn.textContent = `Advanced API parameters ${hasApiAdvancedValues ? '▾' : '▸'}`;
  }

  renderSchemaFields('inputs-fields',  s.ws_inputs_schema?.properties||{},  s.ws_inputs_schema?.required||[]);
  renderSchemaFields('outputs-fields', s.ws_output_schema?.properties||{}, s.ws_output_schema?.required||[]);
  onTypeChange(); updateJsonTab(); updateRunTab(s);
}

function onTypeChange() {
  const t=document.getElementById('f-type').value;
  const p=t==='prompt'||t==='tool', a=t==='api'||t==='webpage', w=t==='webpage', tool=t==='tool';
  document.getElementById('llm-section').style.display       = p?'':'none';
  document.getElementById('sysprompt-section').style.display = p?'':'none';
  document.getElementById('template-section').style.display  = p?'':'none';
  document.getElementById('api-section').style.display       = a?'':'none';
  document.getElementById('tool-section').style.display      = tool?'':'none';
  document.getElementById('method-section').style.display    = w?'none':'';
  document.getElementById('url-hint').textContent            = w
    ? 'Fetches browser-like raw HTML from this URL. Use {{input_name}} for dynamic params.'
    : 'Use {{input_name}} for dynamic params';

  const apiBody = document.getElementById('api-body-section');
  if (apiBody) apiBody.style.display = w ? 'none' : '';
  const webpageModeSection = document.getElementById('webpage-mode-section');
  if (webpageModeSection) webpageModeSection.style.display = w ? '' : 'none';
  const webpageBrowserOptions = document.getElementById('webpage-browser-options');
  if (webpageBrowserOptions) {
    const mode = document.getElementById('f-webpage-mode')?.value || 'http';
    webpageBrowserOptions.style.display = w && mode === 'browser' ? '' : 'none';
  }
}

function onProviderChange(currentModel) {
  const p = document.getElementById('f-provider')?.value || 'anthropic';
  const sel = document.getElementById('f-model');
  if (!sel) return;
  const models = _providersConfig[p]?.models || [PROVIDER_MODEL_HINTS[p] || ''];
  const target = currentModel || sel.value || models[0] || '';
  sel.innerHTML = models.map(m =>
    `<option value="${m}"${m===target?' selected':''}>${m}</option>`
  ).join('');
  if (target && !models.includes(target)) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${target}" selected>${target}</option>`);
  }
}

function renderSchemaFields(containerId,props,required) {
  const container=document.getElementById(containerId);
  container.innerHTML='';
  Object.keys(props).forEach(k=>addSchemaRow(container,k,props[k].type||'string',required.includes(k)));
}

function addSchemaRow(container,name='',type='string',req=false) {
  const row=document.createElement('div');
  row.className='schema-field-row';
  row.innerHTML=`
    <input class="form-input" placeholder="field_name" value="${name}" style="flex:2">
    <select class="form-select" style="flex:1">${FIELD_TYPES.map(t=>`<option ${t===type?'selected':''}>${t}</option>`).join('')}</select>
    <input type="checkbox" class="schema-req-check" title="Required" ${req?'checked':''}>
    <button class="schema-remove-btn" onclick="this.parentElement.remove()">&#x2715;</button>`;
  container.appendChild(row);
}

function addInputField()  { addSchemaRow(document.getElementById('inputs-fields')); }
function addOutputField() { addSchemaRow(document.getElementById('outputs-fields')); }

function readSchemaFields(containerId) {
  const rows=document.getElementById(containerId).querySelectorAll('.schema-field-row');
  const props={},required=[];
  rows.forEach(row=>{
    const inputs=row.querySelectorAll('input,select');
    const name=inputs[0].value.trim(),type=inputs[1].value,req=inputs[2].checked;
    if(name){ props[name]={ type }; if(req) required.push(name); }
  });
  return { type:'object',required,properties:props };
}

function collectStep() {
  const type=document.getElementById('f-type').value;
  const s={ ws_name:document.getElementById('f-name').value.trim(), ws_type:type,
    ws_inputs_schema:readSchemaFields('inputs-fields'), ws_output_schema:readSchemaFields('outputs-fields') };
  const stepDesc = document.getElementById('f-step-desc')?.value?.trim() || '';
  if (stepDesc) s.step_desc = stepDesc;
  if (type==='prompt' || type==='tool') {
    const _prov=document.getElementById('f-provider').value;
    const _model=document.getElementById('f-model').value.trim() || PROVIDER_MODEL_HINTS[_prov] || '';
    s.ws_llm={ provider:_prov, model:_model, temperature:parseFloat(document.getElementById('f-temp').value)||0 };
    s.ws_system_prompt  =document.getElementById('f-sysprompt').value;
    s.ws_prompt_template=document.getElementById('f-template').value;
    if (type==='tool') {
      const mcp_server_label = document.getElementById('f-tool-mcp-server')?.value || '';
      const tool_name = document.getElementById('f-tool-name')?.value || '';
      s.ws_tool = { mcp_server_label, tool_name };
      s.ws_tools = tool_name ? [tool_name] : [];
    }
  }
  if (type==='api') {
    const headers = parseJsonEditorField('f-api-headers', 'API headers');
    const query = parseJsonEditorField('f-api-query', 'API query params');
    const body = parseJsonEditorField('f-api-body', 'API body');
    if ([headers, query, body].includes(null)) return null;
    const apiObj = { method:document.getElementById('f-method').value, url:document.getElementById('f-url').value.trim() };
    if (headers !== undefined) apiObj.headers = headers;
    if (query !== undefined) apiObj.query = query;
    if (body !== undefined) apiObj.body = body;
    s.ws_api = apiObj;
  }
  if (type==='webpage') {
    const headers = parseJsonEditorField('f-api-headers', 'Webpage headers');
    const browserOptions = parseJsonEditorField('f-webpage-browser-options', 'Webpage browser options');
    if ([headers, browserOptions].includes(null)) return null;
    const mode = document.getElementById('f-webpage-mode').value || 'http';
    const webpage = { url:document.getElementById('f-url').value.trim(), mode };
    if (headers !== undefined) webpage.headers = headers;
    if (browserOptions && typeof browserOptions === 'object') {
      if (browserOptions.waitUntil) webpage.waitUntil = browserOptions.waitUntil;
      if (browserOptions.timeoutMs != null) webpage.timeoutMs = Number(browserOptions.timeoutMs);
      if (browserOptions.waitForSelector) webpage.waitForSelector = browserOptions.waitForSelector;
      if (browserOptions.viewport && typeof browserOptions.viewport === 'object') webpage.viewport = browserOptions.viewport;
      if (browserOptions.userAgent) webpage.userAgent = browserOptions.userAgent;
    }
    s.ws_webpage = webpage;
  }
  return s;
}

function _doSaveStep(s) {
  const steps=currentWf.data.steps||[];
  if (currentStep) {
    const idx=steps.findIndex(x=>x.ws_name===currentStep.ws_name);
    if (idx>=0) steps[idx]=s; else steps.push(s);
    if (currentStep.ws_name !== s.ws_name) {
      (currentWf.data.workflows||[]).forEach(wf=>{
        (wf.wf_nodes||[]).forEach(n=>{
          if (n.ws_ref === currentStep.ws_name) n.ws_ref = s.ws_name;
        });
      });
    }
  } else {
    if (steps.find(x=>x.ws_name===s.ws_name)) return toast('A step with this name already exists','err');
    steps.push(s);
    if ((currentWf.data.workflows||[]).some(w => Array.isArray(w.wf_nodes))) {
      ensureWorkflowNodeForStep(s.ws_name);
    }
  }
  currentWf.data.steps=steps;
  currentStep=s;
  buildGraph(currentWf.data); _refreshWfJsonPanel();
  if (guestMode) { _guestSync(); toast('Step saved (not persisted)','ok'); }
  else { saveWorkflow(); toast('Step saved','ok'); }
}

function applyStepEdit() {
  if (!currentWf) return;
  const s=collectStep();
  if (!s) return;
  if (!s.ws_name) return toast('ws_name is required','err');

  // Validate that input variables are referenced in the prompt
  if ((s.ws_type === 'prompt' || s.ws_type === 'tool') && s.ws_inputs_schema?.properties) {
    const inputNames = Object.keys(s.ws_inputs_schema.properties);
    if (inputNames.length > 0) {
      const promptText = (s.ws_system_prompt || '') + ' ' + (s.ws_prompt_template || '');
      const usedVars = inputNames.filter(name => promptText.includes(`{{${name}}}`));
      if (usedVars.length === 0) {
        const varList = inputNames.map(n => `<code>{{${n}}}</code>`).join(', ');
        openModal(
          '⚠ Variables d\'entrée non utilisées',
          `<div class="confirm-text">Aucune variable d'entrée n'est référencée dans le prompt.</div>
           <div class="confirm-sub" style="margin-top:8px">Les variables ${varList} ne sont pas présentes dans le System Prompt ni dans le Template.<br><br>Les entrées ne seront pas transmises au LLM.</div>`,
          [
            { label: 'Sauvegarder quand même', action: () => { closeModal(); _doSaveStep(s); }, primary: true },
            { label: 'Annuler', action: closeModal }
          ]
        );
        return;
      }
    }
  }

  _doSaveStep(s);
}

function deleteCurrentStep() {
  if (!currentStep||!currentWf) return;
  const name=currentStep.ws_name;
  openConfirm(`Delete step "${name}"?`,'It will also be removed from workflow nodes.',()=>{
    currentWf.data.steps=(currentWf.data.steps||[]).filter(s=>s.ws_name!==name);
    (currentWf.data.workflows||[]).forEach(wf=>{
      const removedIds = new Set((wf.wf_nodes||[]).filter(n=>n.ws_ref===name).map(n=>n.step_id));
      wf.wf_nodes=(wf.wf_nodes||[]).filter(n=>n.ws_ref!==name);
      wf.wf_nodes.forEach(n=>{ n.depends_on=(n.depends_on||[]).filter(d=>!removedIds.has(d)); });
    });
    closeModal(); closeEditor(); buildGraph(currentWf.data); _refreshWfJsonPanel();
    saveWorkflow(); toast('Step deleted','ok');
  });
}

function closeEditor() {
  setRightPanelVisible(false);
  currentStep=null;
  _currentNodeId = null;
}

function setExecutionUiState(running) {
  _isExecuting = running;
  document.documentElement.classList.toggle('exec-running', running);
  const stepBtn = document.getElementById('run-step-btn');
  const flowBtn = document.getElementById('run-flow-btn');
  if (!stepBtn || !flowBtn) return;
  if (!running) {
    _runStepDefaultLabel = stepBtn.dataset.defaultLabel || stepBtn.textContent;
    _runFlowDefaultLabel = flowBtn.dataset.defaultLabel || flowBtn.textContent;
  }
  if (running) {
    stepBtn.textContent = '■ Stop';
    flowBtn.textContent = '■ Stop';
  } else {
    stepBtn.textContent = _runStepDefaultLabel;
    flowBtn.textContent = _runFlowDefaultLabel;
  }
}

function appendWorkflowExecLog(line) {
  _workflowExecLogs.push(line);
  const pre = document.getElementById('wf-exec-logs-content');
  if (pre) { pre.textContent = _workflowExecLogs.join('\n'); pre.scrollTop = pre.scrollHeight; }
}

function formatWorkflowEventContext(data = {}) {
  const parts = [];
  if (data.step_id) parts.push(`step_id=${data.step_id}`);
  if (data.ws_ref) parts.push(`ws_ref=${data.ws_ref}`);
  if (data.step_desc) parts.push(`step_desc=${data.step_desc}`);
  if (data.status) parts.push(`status=${data.status}`);
  if (data.last_step?.ws_ref) parts.push(`last_ws_ref=${data.last_step.ws_ref}`);
  if (data.last_step?.step_desc) parts.push(`last_step_desc=${data.last_step.step_desc}`);
  return parts.length ? ` [${parts.join(' | ')}]` : '';
}

function formatDetailedWorkflowError(data = {}) {
  const chunks = [];
  if (data.error) chunks.push(`error=${data.error}`);
  if (Array.isArray(data.details) && data.details.length) {
    chunks.push(`details=${data.details.join(' ; ')}`);
  }
  if (data.error_details?.code) chunks.push(`code=${data.error_details.code}`);
  const causes = data.error_details?.causes;
  if (Array.isArray(causes) && causes.length) {
    const causeText = causes
      .map((cause, idx) => `#${idx + 1} ${cause.name || 'Error'}: ${cause.message}${cause.code ? ` (code=${cause.code})` : ''}`)
      .join(' -> ');
    chunks.push(`causes=${causeText}`);
  }
  return chunks.length ? ` | ${chunks.join(' | ')}` : '';
}

// FIX #11 — fonctions exposées dans window (étaient manquantes)
async function copyWorkflowExecLogs() {
  const txt = _workflowExecLogs.join('\n');
  if (!txt) { toast('No logs to copy', 'err'); return; }
  try {
    await navigator.clipboard.writeText(txt);
    toast('Workflow logs copied', 'ok');
  } catch {
    toast('Clipboard unavailable', 'err');
  }
}

function clearWorkflowExecLogs() {
  _workflowExecLogs = [];
  const pre = document.getElementById('wf-exec-logs-content');
  if (pre) pre.textContent = '';
}

function setRunningGraphState(nodeId, includeDeps = false) {
  _activeRunNodeIds = new Set();
  _activeRunEdgeIds = new Set();
  if (!currentWf || !nodeId) {
    if (currentWf) buildGraph(currentWf.data);
    return;
  }
  const wf = (currentWf.data.workflows || []).find(w => w.wf_nodes?.length);
  if (!wf) return;
  const node = findWorkflowNode(wf, nodeId);
  if (!node) return;

  _activeRunNodeIds.add(node.step_id);
  if (includeDeps) {
    for (const depRef of (node.depends_on || [])) {
      const depNode = findWorkflowNode(wf, depRef);
      if (!depNode) continue;
      _activeRunNodeIds.add(depNode.step_id);
      _activeRunEdgeIds.add(`${depNode.step_id}->${node.step_id}`);
    }
  }
  buildGraph(currentWf.data);
}

function clearRunningGraphState() {
  if (!_activeRunNodeIds.size && !_activeRunEdgeIds.size) return;
  _activeRunNodeIds.clear();
  _activeRunEdgeIds.clear();
  if (currentWf) buildGraph(currentWf.data);
}

function toggleWorkflowExecLogs() {
  // Conservé pour compatibilité : les logs restent désormais toujours visibles.
}

// FIX #10 — nettoyer les textareas maximisées quand le panneau est masqué
function setRightPanelVisible(visible) {
  const panel = document.getElementById('right-panel');
  const btn = document.getElementById('btn-toggle-right');
  if (!panel || !btn) return;
  if (!visible) {
    if (typeof _jfsSource === 'string' && _jfsSource.startsWith('textarea:')) closeJsonFullscreen();
  }
  panel.classList.toggle('hidden', !visible);
  btn.textContent = visible ? '›' : '‹';
  btn.title = visible ? 'Hide editor' : 'Show editor';
  btn.style.right = visible ? 'var(--right-w)' : '0';
  updateFloatingAddStepPosition();
}

function toggleRightPanel() {
  const panel = document.getElementById('right-panel');
  if (!panel) return;
  setRightPanelVisible(panel.classList.contains('hidden'));
  if (!panel.classList.contains('hidden') && currentStep) {
    switchEditorTab(_lastEditorTab || 'edit');
  }
}

function updateFloatingAddStepPosition() {
  const btn = document.getElementById('btn-add-step');
  if (!btn) return;
  btn.style.left = '50%';
  btn.style.bottom = '12px';
  btn.style.top = 'auto';
}

function initWorkflowLogsPanel() {
  const panel = document.getElementById('wf-exec-logs');
  const header = document.getElementById('wf-exec-logs-header');
  if (!panel || !header) return;

  const persistPanelFrame = () => {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(WF_LOGS_PANEL_POS_KEY, JSON.stringify({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }));
  };

  const onMove = (ev) => {
    if (!_logsPanelDrag) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    const left = Math.min(maxLeft, Math.max(0, ev.clientX - _logsPanelDrag.dx));
    const top = Math.min(maxTop, Math.max(0, ev.clientY - _logsPanelDrag.dy));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    persistPanelFrame();
    updateFloatingAddStepPosition();
  };

  const onUp = () => {
    _logsPanelDrag = null;
    persistPanelFrame();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  header.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('.wf-log-action')) return;
    const rect = panel.getBoundingClientRect();
    _logsPanelDrag = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  try {
    const saved = JSON.parse(localStorage.getItem(WF_LOGS_PANEL_POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      panel.style.left = `${Math.max(0, saved.left)}px`;
      panel.style.top = `${Math.max(0, saved.top)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      if (Number.isFinite(saved.width)) panel.style.width = `${Math.max(360, saved.width)}px`;
      if (Number.isFinite(saved.height)) panel.style.height = `${Math.max(120, saved.height)}px`;
    }
  } catch (_) {}

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { persistPanelFrame(); updateFloatingAddStepPosition(); });
    ro.observe(panel);
  }
  window.addEventListener('resize', updateFloatingAddStepPosition);
  updateFloatingAddStepPosition();
}

function switchEditorTab(tab) {
  _lastEditorTab = tab || _lastEditorTab || 'edit';
  document.querySelectorAll('.etab').forEach((b,i)=>b.classList.toggle('active',['edit','run','log','json'][i]===_lastEditorTab));
  document.querySelectorAll('.etab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById(`etab-${_lastEditorTab}`)?.classList.add('active');
  if (_lastEditorTab==='json') updateJsonTab();
}

function toggleTechSection() {
  const content = document.getElementById('tech-content');
  const btn = document.getElementById('tech-toggle');
  if (!content || !btn) return;
  const collapsed = content.classList.toggle('collapsed');
  btn.textContent = `${btn.textContent.replace(/[▾▸]/g, '').trim()} ${collapsed ? '▸' : '▾'}`;
}

function toggleApiAdvancedSection() {
  const content = document.getElementById('api-advanced-content');
  const btn = document.getElementById('api-advanced-toggle');
  if (!content || !btn) return;
  const collapsed = content.classList.toggle('collapsed');
  btn.textContent = `${btn.textContent.replace(/[▾▸]/g, '').trim()} ${collapsed ? '▸' : '▾'}`;
}

function toggleToolAdvancedSection() {
  const content = document.getElementById('tool-advanced-content');
  const btn = document.getElementById('tool-advanced-toggle');
  if (!content || !btn) return;
  const collapsed = content.classList.toggle('collapsed');
  btn.textContent = `${btn.textContent.replace(/[▾▸]/g, '').trim()} ${collapsed ? '▸' : '▾'}`;
}

function populateToolServerSelect(selected = '') {
  const sel = document.getElementById('f-tool-mcp-server');
  if (!sel) return;
  const rows = _mcpServers || [];
  const current = selected || sel.value || rows[0]?.server_label || '';
  if (!rows.length) {
    sel.innerHTML = '<option value="">Aucun serveur MCP configuré</option>';
    return;
  }
  sel.innerHTML = rows.map(r => `<option value="${r.server_label}"${r.server_label===current?' selected':''}>${r.server_label}</option>`).join('');
}

function onToolMcpServerChange(selectedTool = '') {
  const mcpLabel = document.getElementById('f-tool-mcp-server')?.value || '';
  const srv = (_mcpServers || []).find(x => x.server_label === mcpLabel);
  const toolSel = document.getElementById('f-tool-name');
  if (!toolSel) return;
  const tools = srv?.tools || [];
  if (!tools.length) {
    toolSel.innerHTML = '<option value="">Aucun tool découvert</option>';
    return;
  }
  const pick = selectedTool || toolSel.value || tools[0]?.name || tools[0] || '';
  toolSel.innerHTML = tools.map(t => {
    const name = typeof t === 'string' ? t : (t?.name || 'unnamed_tool');
    return `<option value="${name}"${name===pick?' selected':''}>${name}</option>`;
  }).join('');
}

const _textareaFullscreenLabels = {
  'f-sysprompt': 'System Prompt',
  'f-template':  'Prompt Template',
};

function toggleEditorMaximize(textareaId) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  const label = _textareaFullscreenLabels[textareaId] || textareaId;
  _jfsSource = 'textarea:' + textareaId;
  const overlay = document.getElementById('json-fullscreen');
  const fsTa    = document.getElementById('json-fullscreen-textarea');
  const nameEl  = document.getElementById('json-fullscreen-name');
  const applyBtn= document.getElementById('jfs-apply-btn');
  const errEl   = document.getElementById('json-fullscreen-err');
  nameEl.textContent = label;
  fsTa.value = ta.value;
  fsTa.classList.remove('err');
  errEl.textContent = '';
  applyBtn.style.display = '';
  overlay.classList.remove('hidden');
  setTimeout(() => fsTa.focus(), 50);
}

function toggleSyspromptSection() {
  const content = document.getElementById('sysprompt-content');
  const btn = document.getElementById('sysprompt-fold-btn');
  if (!content || !btn) return;
  const collapsed = content.classList.toggle('collapsed');
  btn.textContent = collapsed ? '▸' : '▾';
}

function toggleTemplateSection() {
  const content = document.getElementById('template-content');
  const btn = document.getElementById('template-fold-btn');
  if (!content || !btn) return;
  const collapsed = content.classList.toggle('collapsed');
  btn.textContent = collapsed ? '▸' : '▾';
}

function startRightPanelResize(e) {
  e.preventDefault();
  const panel = document.getElementById('right-panel');
  if (!panel) return;
  const startX = e.clientX;
  const startW = panel.offsetWidth;
  const MIN_W = 380;
  panel.classList.add('resizing');
  document.documentElement.classList.add('right-panel-resizing');
  const onMove = (ev) => {
    const newW = Math.max(MIN_W, startW + (startX - ev.clientX));
    document.documentElement.style.setProperty('--right-w', newW + 'px');
  };
  const onUp = () => {
    panel.classList.remove('resizing');
    document.documentElement.classList.remove('right-panel-resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function updateJsonTab() {
  const s=currentStep||collectStep();
  if (!s) return;
  document.getElementById('step-json').innerHTML=syntaxHighlight(JSON.stringify(s,null,2));
}

// ── RUN ──────────────────────────────────────────────────────────
function rememberStepResult(step, nodeId, result) {
  if (!result) return;
  const key = nodeId || step.ws_name;
  _lastStepRuns[key] = result;
}

function buildInheritedInputs(step, nodeId) {
  if (!currentWf || !nodeId) return {};
  const wf = (currentWf.data.workflows || []).find(w => w.wf_nodes?.length);
  if (!wf) return {};
  const node = findWorkflowNode(wf, nodeId);
  if (!node) return {};
  const inherited = {};
  for (const depId of (node.depends_on || [])) {
    const depNode = findWorkflowNode(wf, depId);
    if (!depNode) continue;
    const depOutput = _lastStepRuns[depNode.step_id] || _lastStepRuns[depNode.ws_ref];
    if (!depOutput || typeof depOutput !== 'object') continue;
    Object.assign(inherited, depOutput);
  }
  return inherited;
}

function getAvailableConnectedInputs(step, nodeId) {
  if (!currentWf || !nodeId) return [];
  const wf = (currentWf.data.workflows || []).find(w => w.wf_nodes?.length);
  if (!wf) return [];
  const node = findWorkflowNode(wf, nodeId);
  if (!node) return [];
  const names = new Set();
  for (const depId of (node.depends_on || [])) {
    const depNode = findWorkflowNode(wf, depId);
    if (!depNode) continue;
    const depStep = (currentWf.data.steps || []).find(s => s.ws_name === depNode.ws_ref);
    const outProps = depStep?.ws_output_schema?.properties || {};
    Object.keys(outProps).forEach(k => names.add(k));
  }
  return Array.from(names).sort();
}

function getDeprecatedDependencyAliases(step, nodeId) {
  if (!step?.ws_prompt_template || !currentWf || !nodeId) return [];
  const wf = (currentWf.data.workflows || []).find(w => w.wf_nodes?.length);
  if (!wf) return [];
  const node = findWorkflowNode(wf, nodeId);
  if (!node) return [];

  const aliases = [];
  for (const depId of (node.depends_on || [])) {
    const depNode = findWorkflowNode(wf, depId);
    if (!depNode?.ws_ref) continue;
    aliases.push(depNode.ws_ref, `${depNode.ws_ref}_output`);
  }

  const template = step.ws_prompt_template || '';
  return aliases.filter((alias, idx) => {
    if (aliases.indexOf(alias) !== idx) return false;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\{\\{\\{?\\s*${escaped}\\s*\\}\\}?`);
    return pattern.test(template);
  });
}

function updateRunTab(s) {
  const area = document.getElementById('run-inputs-area');
  area.innerHTML = '';
  const availableEl = document.getElementById('edit-available-inputs');
  const inProps = s?.ws_inputs_schema?.properties || {};
  const inReq   = s?.ws_inputs_schema?.required   || [];

  // Rendu des inputs + pré-remplissage depuis les output vars du step précédent
  const inheritedInputs = buildInheritedInputs(s, _currentNodeId);

  Object.keys(inProps).forEach(k => {
    const div = document.createElement('div');
    div.innerHTML = `<div class="run-input-label">${k} <span class="field-type">${inProps[k].type||''}</span>${inReq.includes(k)?'<span class="run-input-req">req</span>':''}</div><textarea class="form-textarea" id="run-in-${k}" placeholder="Value for ${k}…"></textarea>`;
    area.appendChild(div);

    // Pré-remplir depuis les outputs connectés des steps en amont
    if (inheritedInputs[k] !== undefined) {
      const ta = div.querySelector(`#run-in-${k}`);
      if (ta) ta.value = typeof inheritedInputs[k] === 'string' ? inheritedInputs[k] : JSON.stringify(inheritedInputs[k], null, 2);
    }
  });

  // Écraser / compléter avec les dernières valeurs saisies par l'utilisateur
  const state = getStepRunState(s, _currentNodeId);
  if (state?.lastInputs) {
    Object.entries(state.lastInputs).forEach(([k, v]) => {
      const el = document.getElementById(`run-in-${k}`);
      if (!el) return;
      el.value = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    });
  }

  if (availableEl) {
    const vars = getAvailableConnectedInputs(s, _currentNodeId);
    const deprecatedAliases = getDeprecatedDependencyAliases(s, _currentNodeId);
    const varsHtml = vars.length
      ? vars.map(v => `<span class="run-var-chip">{{${v}}}</span>`).join('')
      : '<span class="run-available-empty">Aucune variable disponible (connectez un step entrant).</span>';

    const warningHtml = deprecatedAliases.length
      ? `<div class="run-available-empty" style="margin-bottom:8px;color:#f59e0b;">⚠️ Alias dépréciés détectés dans le template: ${deprecatedAliases.map(a => `{{${escapeHtml(a)}}}`).join(', ')}. Utilisez uniquement les champs explicites du ws_output_schema.</div>`
      : '';

    availableEl.innerHTML = `${warningHtml}${varsHtml}`;
  }

  renderRunState(s, _currentNodeId);
  hydrateRunStateFromServer(s, _currentNodeId);
}

// FIX #6 — anti-réentrance + suppression de l'appel récursif updateRunTab
async function hydrateRunStateFromServer(step, nodeId) {
  const key = nodeId || step?.ws_name;
  if (!currentUser || !currentWf || !key) return;
  if (getStepRunState(step, nodeId)) return;   // état déjà connu
  if (_hydratingNodes.has(key)) return;         // hydratation déjà en cours
  _hydratingNodes.add(key);

  try {
    const wf = encodeURIComponent(currentWf.name);
    const ws = encodeURIComponent(step.ws_name);
    const res = await api(`/api/exec/history/latest?workflow=${wf}&step=${ws}`);
    if (res?.record) {
      saveStepRunState(step, nodeId, {
        status: res.record.status || 'idle',
        output: typeof res.record.output === 'string' ? res.record.output : JSON.stringify(res.record.output || '', null, 2),
        logOutput: `${res.record.prompt ? `PROMPT:\n${res.record.prompt}\n\n` : ''}${res.record.logOutput || ''}`,
        logMeta: res.record.logMeta || '',
        logError: res.record.status === 'error',
        lastInputs: res.record.inputs || {}
      });
      // N'actualiser l'UI que si le step affiché est toujours le même
      if (_currentNodeId === key) {
        renderRunState(step, nodeId);
        // Restaurer les valeurs de lastInputs dans les textareas
        const lastInputs = res.record.inputs || {};
        Object.entries(lastInputs).forEach(([k, v]) => {
          const el = document.getElementById(`run-in-${k}`);
          if (!el) return;
          el.value = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        });
      }
    }
  } finally {
    _hydratingNodes.delete(key);
  }
}

function stopExecution() {
  if (_runController) _runController.abort();
  if (_workflowRunId && currentUser) {
    fetch(`/api/exec/runs/${encodeURIComponent(_workflowRunId)}/stop`, {
      method: 'POST',
      credentials: 'include'
    }).catch(() => {});
  }
}

function findWorkflowNode(wf, ref) {
  if (!wf || !ref) return null;
  return (wf.wf_nodes || []).find(n => n.step_id === ref || n.ws_ref === ref) || null;
}

function getStepRunState(step, nodeId) {
  const key = nodeId || step?.ws_name;
  if (!key) return null;
  return _stepRunUiState[key] || null;
}

function saveStepRunState(step, nodeId, patch) {
  const key = nodeId || step?.ws_name;
  if (!key) return;
  _stepRunUiState[key] = {
    status: 'idle',
    output: '',
    lastInputs: {},
    logOutput: '',
    logMeta: '',
    ...(_stepRunUiState[key] || {}),
    ...(patch || {})
  };
}

function renderRunState(step, nodeId) {
  const state = getStepRunState(step, nodeId);
  const statusEl = document.getElementById('run-status');
  const varsEl = document.getElementById('run-output-vars');
  const logOutEl = document.getElementById('run-log-output');
  const logMetaEl = document.getElementById('run-log-meta');
  if (!statusEl || !varsEl || !logOutEl || !logMetaEl) return;

  if (!state) {
    statusEl.textContent = 'idle';
    statusEl.className = 'run-status idle';
    varsEl.textContent = '// No output captured yet…';
    logOutEl.textContent = '// Full prompt + execution log will appear here…';
    logOutEl.className = 'run-output';
    logMetaEl.innerHTML = '';
    return;
  }

  statusEl.textContent = state.status || 'idle';
  statusEl.className = `run-status ${(state.status||'idle').toLowerCase()}`;
  renderOutputVars(varsEl, state.output);
  logOutEl.textContent = state.logOutput || '// Full prompt + execution log will appear here…';
  logOutEl.className = `run-output${state.logError ? ' error' : ''}`;
  logMetaEl.innerHTML = state.logMeta || '';
}

function renderOutputVars(container, rawOutput) {
  if (!container) return;
  if (!rawOutput) { container.textContent = '// No output captured yet…'; return; }

  let parsed = null;
  if (typeof rawOutput === 'object' && rawOutput !== null) parsed = rawOutput;
  else if (typeof rawOutput === 'string') {
    try { parsed = JSON.parse(rawOutput); } catch { /* keep raw */ }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    container.textContent = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2);
    return;
  }

  container.innerHTML = Object.entries(parsed).map(([k, v]) => {
    const txt = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (txt.includes('\n')) {
      return `<details><summary><span class="var-name">${escapeHtml(k)}</span></summary><pre>${escapeHtml(txt)}</pre></details>`;
    }
    return `<div class="var-row"><span class="var-name">${escapeHtml(k)}</span><span>${escapeHtml(txt)}</span></div>`;
  }).join('');
}

function buildSchemaMismatchLogText(payload, fallbackMessage = '') {
  if (!payload || payload.error !== 'Inputs do not match ws_inputs_schema') return fallbackMessage;
  const lines = [payload.error];
  if (Array.isArray(payload.details) && payload.details.length) {
    lines.push('', 'details:', ...payload.details.map((d) => `- ${d}`));
  }
  if (payload.expected_schema != null) {
    lines.push('', 'expected_schema:', JSON.stringify(payload.expected_schema, null, 2));
  }
  if (payload.received_schema != null) {
    lines.push('', 'received_schema:', JSON.stringify(payload.received_schema, null, 2));
  }
  return lines.join('\n');
}

async function executeStep(stepDef, runMode='step_only') {
  const s = stepDef || currentStep || collectStep();
  if (!s) return false;
  if (!s.ws_name) { toast('Save the step first','err'); return false; }

  const inProps=s.ws_inputs_schema?.properties||{}, inputs={};
  const inheritedInputs = buildInheritedInputs(s, _currentNodeId);
  for (const k of Object.keys(inProps)) {
    const el=document.getElementById(`run-in-${k}`); if(!el) continue;
    if (!el.value.trim()) continue;
    let val=el.value; try{ val=JSON.parse(val); }catch{}
    inputs[k]=val;
  }
  const finalInputs = { ...inheritedInputs, ...inputs };

  const statusEl=document.getElementById('run-status');
  const varsEl=document.getElementById('run-output-vars');
  const outEl=document.getElementById('run-log-output');
  const metaEl=document.getElementById('run-log-meta');
  varsEl.textContent='';
  outEl.textContent=''; outEl.className='run-output'; metaEl.innerHTML='';
  statusEl.textContent='running'; statusEl.className='run-status running';
  saveStepRunState(s, _currentNodeId, { status:'running', output:'', lastInputs: inputs, logOutput:'', logMeta:'', logError:false });
  _runController = new AbortController();

  const tsStart = Date.now();
  const ts = () => new Date().toISOString().slice(11,23);
  setRunningGraphState(_currentNodeId || s.ws_name, runMode === 'workflow_from_here');
  const canUseRefExec = Boolean(currentUser && currentWf?.name && _currentNodeId);
  const execUrl = canUseRefExec
    ? `/api/exec/workflows/${encodeURIComponent(currentWf.name)}/step`
    : '/api/exec/step';
  const execBody = canUseRefExec
    ? { ws_ref: s.ws_name, step_id: _currentNodeId, inputs: finalInputs }
    : { step:s, inputs: finalInputs, context:{ workflowName: currentWf?.name, nodeId:_currentNodeId, runMode } };

  if (['api','webpage'].includes((s.ws_type||'').toLowerCase())) {
    const headers = { 'Content-Type':'application/json' };
    let res;
    try {
      const r = await fetch(execUrl, { method:'POST', headers, credentials:'include', signal:_runController.signal, body:JSON.stringify(execBody) });
      res = await r.json();
    } catch(e) {
      const msg = e.name === 'AbortError' ? 'Execution stopped by user' : e.message;
      outEl.className='run-output error'; outEl.textContent=msg;
      statusEl.textContent=e.name === 'AbortError' ? 'stopped' : 'error'; statusEl.className='run-status error';
      saveStepRunState(s, _currentNodeId, { status:statusEl.textContent, output:'', logOutput:msg, logMeta:'', logError:true });
      return false;
    }
    const elapsed = Date.now()-tsStart;
    if (res.error) {
      const logMessage = buildSchemaMismatchLogText(res, res.error);
      outEl.className='run-output error'; outEl.textContent=logMessage;
      metaEl.innerHTML=`<span style="color:var(--red)">✕ error</span> · ${elapsed}ms · ${ts()}`;
      statusEl.textContent='error'; statusEl.className='run-status error';
      saveStepRunState(s, _currentNodeId, { status:'error', logOutput:logMessage, logMeta:metaEl.innerHTML, logError:true });
      return false;
    }
    const resultText = JSON.stringify(res.result,null,2);
    outEl.textContent=resultText;
    renderOutputVars(varsEl, res.result);
    rememberStepResult(s, _currentNodeId, res.result);
    metaEl.innerHTML=`✓ ${(s.ws_type||'api').toLowerCase()} · ${elapsed}ms · ${ts()}`;
    statusEl.textContent='done'; statusEl.className='run-status done';
    saveStepRunState(s, _currentNodeId, { status:'done', output:resultText, logOutput:resultText, logMeta:metaEl.innerHTML, logError:false });
    return true;
  }

  try {
    const headers = { 'Content-Type':'application/json' };
    const resp = await fetch(execUrl, { method:'POST', headers, credentials:'include', signal:_runController.signal, body:JSON.stringify(execBody) });
    if (!resp.ok) {
      const errBody = await resp.json().catch(()=>({ error:`HTTP ${resp.status}` }));
      throw new Error(buildSchemaMismatchLogText(errBody, errBody.error || `HTTP ${resp.status}`));
    }
    const reader=resp.body.getReader(), decoder=new TextDecoder();
    let buffer='', full='';
    while(true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      const parts = buffer.split('\n\n'); buffer = parts.pop();
      for (const part of parts) {
        const lines = part.split('\n');
        const event = lines.find(l=>l.startsWith('event: '))?.slice(7) || 'message';
        const data  = lines.find(l=>l.startsWith('data: '))?.slice(6);
        if (!data) continue;
        const obj = JSON.parse(data);
        if (event==='token') {
          full += obj.text;
          outEl.textContent = full;
          saveStepRunState(s, _currentNodeId, { status:'running', logOutput:full });
        } else if (event==='done') {
          const elapsed = Date.now()-tsStart;
          if (obj.parsed) {
            const parsedText = JSON.stringify(obj.parsed, null, 2);
            outEl.textContent = parsedText;
            renderOutputVars(varsEl, obj.parsed);
            rememberStepResult(s, _currentNodeId, obj.parsed);
            metaEl.innerHTML  = `✓ parsed json · ${elapsed}ms · ${ts()}`;
            statusEl.textContent='done'; statusEl.className='run-status done';
            saveStepRunState(s, _currentNodeId, { status:'done', output:parsedText, logOutput:parsedText, logMeta:metaEl.innerHTML, logError:false });
          } else {
            outEl.textContent = full;
            renderOutputVars(varsEl, full);
            metaEl.innerHTML = `<span style="color:var(--amber)">⚠ json parse failed — raw output</span> · ${elapsed}ms · ${ts()}`;
            statusEl.textContent='done_raw'; statusEl.className='run-status done';
            saveStepRunState(s, _currentNodeId, { status:'done_raw', output:full, logOutput:full, logMeta:metaEl.innerHTML, logError:false });
          }
        } else if (event==='error') {
          const elapsed = Date.now()-tsStart;
          outEl.className='run-output error'; outEl.textContent=obj.message;
          metaEl.innerHTML=`<span style="color:var(--red)">✕ ${ts()}</span> · ${elapsed}ms`;
          statusEl.textContent='error'; statusEl.className='run-status error';
          saveStepRunState(s, _currentNodeId, { status:'error', output:'', logOutput:obj.message, logMeta:metaEl.innerHTML, logError:true });
          return false;
        }
      }
    }
  } catch(e) {
    const elapsed = Date.now()-tsStart;
    const aborted = e.name === 'AbortError';
    const msg = aborted ? 'Execution stopped by user' : e.message;
    outEl.className='run-output error'; outEl.textContent=msg;
    metaEl.innerHTML=`<span style="color:var(--red)">✕ ${ts()}</span> · ${elapsed}ms`;
    statusEl.textContent=aborted ? 'stopped' : 'error'; statusEl.className='run-status error';
    saveStepRunState(s, _currentNodeId, { status:aborted ? 'stopped' : 'error', output:'', logOutput:msg, logMeta:metaEl.innerHTML, logError:true });
    return false;
  }
  return true;
}

async function runStepOnly() {
  if (_isExecuting) return stopExecution();
  if (!currentStep) return;
  setExecutionUiState(true);
  try { await executeStep(currentStep, 'step_only'); }
  finally { _runController = null; setExecutionUiState(false); clearRunningGraphState(); }
}

// FIX #2 — sauvegarder/restaurer currentStep et _currentNodeId pour ne pas corrompre l'état éditeur
async function runWorkflowFromHere() {
  if (_isExecuting) return stopExecution();
  if (!currentStep || !_currentNodeId) return;
  if (!currentUser || !currentWf?.name) {
    toast('Sign in required for backend workflow orchestration', 'err');
    return;
  }

  const savedStep   = currentStep;
  const savedNodeId = _currentNodeId;
  const inProps = savedStep.ws_inputs_schema?.properties || {};
  const triggerInputs = {};
  for (const k of Object.keys(inProps)) {
    const el=document.getElementById(`run-in-${k}`); if(!el) continue;
    if (!el.value.trim()) continue;
    let val=el.value; try{ val=JSON.parse(val); }catch{}
    triggerInputs[k]=val;
  }

  setExecutionUiState(true);
  try {
    clearWorkflowExecLogs();
    clearRunningGraphState();
    appendWorkflowExecLog(`${wfTs()} ## Workflow ## Start from ${savedNodeId} (backend orchestrator)`);
    const launchResp = await fetch(`/api/exec/workflows/${encodeURIComponent(currentWf.name)}/run`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      credentials: 'include',
      body: JSON.stringify({ from_step_id: savedNodeId, inputs: triggerInputs })
    });
    const launch = await launchResp.json().catch(() => ({}));
    if (!launchResp.ok || !launch?.run_id) throw new Error(launch.error || `HTTP ${launchResp.status}`);

    _workflowRunId = launch.run_id;
    _runController = new AbortController();

    const streamResp = await fetch(`/api/exec/runs/${encodeURIComponent(_workflowRunId)}/stream`, {
      credentials: 'include',
      signal: _runController.signal
    });
    if (!streamResp.ok) throw new Error(`HTTP ${streamResp.status} while opening run stream`);

    const wf = (currentWf?.data?.workflows || []).find(w => w.wf_nodes?.length);
    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (const frame of frames) {
        const lines = frame.split('\n');
        const event = lines.find(l=>l.startsWith('event: '))?.slice(7) || 'message';
        const raw = lines.find(l=>l.startsWith('data: '))?.slice(6);
        if (!raw) continue;
        const data = JSON.parse(raw);

        if (event === 'step_started') {
          const node = findWorkflowNode(wf, data.step_id);
          const step = (currentWf.data.steps || []).find(st => st.ws_name === data.ws_ref);
          if (!node || !step) continue;
          const stepLabel = data.step_desc || step.ws_name;
          currentStep = step;
          _currentNodeId = node.step_id;
          setRunningGraphState(node.step_id, true);
          saveStepRunState(step, node.step_id, {
            status:'running',
            output:'',
            lastInputs:data.inputs || {},
            logOutput:'',
            logMeta:'backend orchestrated running',
            logError:false
          });
          appendWorkflowExecLog(`${wfTs()} ## ${stepLabel} ## Start${formatWorkflowEventContext(data)}`);
          continue;
        }

        if (event === 'step_finished') {
          const node = findWorkflowNode(wf, data.step_id);
          const step = (currentWf.data.steps || []).find(st => st.ws_name === data.ws_ref);
          if (!node || !step) continue;
          const stepLabel = data.step_desc || step.ws_name;
          const isError = data.status !== 'done';
          const outputText = isError
            ? buildSchemaMismatchLogText(data, data.error || '')
            : JSON.stringify(data.output ?? '', null, 2);
          if (!isError) rememberStepResult(step, node.step_id, data.output);
          saveStepRunState(step, node.step_id, {
            status: isError ? 'error' : 'done',
            output: outputText,
            logOutput: outputText,
            logMeta: isError ? 'backend orchestrated error' : 'backend orchestrated done',
            logError: isError
          });
          appendWorkflowExecLog(`${wfTs()} ## ${stepLabel} ## End${formatWorkflowEventContext(data)}${isError ? formatDetailedWorkflowError(data) : ''}`);
          if (_currentNodeId === node.step_id) renderRunState(step, node.step_id);
          continue;
        }

        if (event === 'workflow_finished') {
          appendWorkflowExecLog(`${wfTs()} ## Workflow ## End${formatWorkflowEventContext(data)}${formatDetailedWorkflowError(data)}`);
          finished = true;
          break;
        }
      }
    }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Execution stopped by user' : (err?.message || 'Workflow execution failed');
    appendWorkflowExecLog(`${wfTs()} ## Workflow ## Error: ${msg}`);
    toast(msg, 'err');
  } finally {
    _workflowRunId = null;
    _runController = null;
    setExecutionUiState(false);
    clearRunningGraphState();
    // Restaurer l'état de l'éditeur au step initial
    currentStep   = savedStep;
    _currentNodeId = savedNodeId;
    if (currentStep) renderRunState(currentStep, _currentNodeId);
  }
}

// ── SETTINGS ─────────────────────────────────────────────────────
function openSettings() {
  if (guestMode) { showSignupCTA(); return; }
  openModal('Settings',`
    <div class="settings-tabs">
      <button class="settings-tab active" id="s-tab-account" onclick="switchSettingsTab('account')">Compte</button>
      <button class="settings-tab" id="s-tab-llm" onclick="switchSettingsTab('llm')">LLM</button>
      <button class="settings-tab" id="s-tab-mcp" onclick="switchSettingsTab('mcp')">Configuration MCP</button>
    </div>

    <div class="settings-pane active" id="s-pane-account">
      <div class="settings-section">
        <div class="settings-title">Change Password</div>
        <input class="settings-input" id="s-oldpw" type="password" placeholder="Current password" style="margin-bottom:6px">
        <input class="settings-input" id="s-newpw" type="password" placeholder="New password (min. 8 chars)">
        <button class="settings-btn" onclick="changePassword()" style="margin-top:8px">Change</button>
        <div id="s-pw-msg"></div>
      </div>
      <div class="settings-section">
        <div class="settings-title">Language</div>
        <div class="settings-row">
          <select class="settings-input" id="s-lang" onchange="setLanguage(this.value)">
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </div>
      </div>
    </div>

    <div class="settings-pane" id="s-pane-llm">
      <div class="settings-section">
        <div class="settings-title">API Keys</div>
        <div class="settings-desc">Keys are encrypted AES-256 on the server, never exposed to the browser.</div>
        <div class="settings-row" style="margin-bottom:6px">
          <select class="settings-input" id="s-provider" onchange="onSettingsProviderChange()" style="max-width:140px;flex:none">
            <option value="anthropic">anthropic</option>
            <option value="openai">openai (ChatGPT)</option>
            <option value="perplexity">perplexity</option>
            <option value="mistral">mistral</option>
          </select>
          <input class="settings-input" id="s-apikey" type="password" placeholder="sk-ant-api03-…">
          <button class="settings-btn" onclick="saveApiKey()">Save</button>
          <button class="settings-btn danger" onclick="deleteApiKey()" title="Remove key" style="padding:0 8px">✕</button>
        </div>
        <div id="s-apikey-msg"></div>
      </div>
    </div>

    <div class="settings-pane" id="s-pane-mcp">
      <div class="settings-section">
        <div class="settings-title">Registre des MCP servers</div>
        <div class="settings-desc">Champs requis: server_label, server_url. api_key requis seulement à la création/remplacement. Les tools sont découverts après validation.</div>
        <div id="s-mcp-list"></div>
        <div class="settings-row">
          <button class="settings-btn" onclick="addMcpServerRow()">+ Ajouter serveur</button>
          <button class="settings-btn" onclick="saveMcpServers()">Enregistrer registre</button>
        </div>
        <div id="s-mcp-msg"></div>
      </div>
    </div>`,
    [{ label:'Close', action:closeModal }]
  );
  loadProviderKeyStatus();
  const qpLang = new URLSearchParams(window.location.search).get('lang');
  const cookieLang = document.cookie.split('; ').find(v=>v.startsWith('lang='))?.split('=')[1];
  const currentLang = qpLang || cookieLang || 'en';
  const sLang = document.getElementById('s-lang');
  if (sLang) sLang.value = currentLang;
}

function switchSettingsTab(tab) {
  ['account','llm','mcp'].forEach(name => {
    document.getElementById(`s-tab-${name}`)?.classList.toggle('active', name===tab);
    document.getElementById(`s-pane-${name}`)?.classList.toggle('active', name===tab);
  });
}

function renderMcpServerRows() {
  const list = document.getElementById('s-mcp-list');
  if (!list) return;
  if (!_mcpServers.length) {
    list.innerHTML = '<div class="settings-desc">Aucun serveur MCP configuré.</div>';
    return;
  }
  list.innerHTML = '';

  _mcpServers.forEach((srv, i) => {
    const item = document.createElement('div');
    item.className = 'settings-mcp-item';

    const mkInputRow = (id, placeholder, value = '', type = 'text') => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.id = id;
      input.placeholder = placeholder;
      input.value = value;
      input.type = type;
      row.appendChild(input);
      return row;
    };

    item.appendChild(mkInputRow(`mcp-label-${i}`, 'server_label', srv.server_label || ''));
    item.appendChild(mkInputRow(`mcp-url-${i}`, 'https://host.example.com/mcp', srv.server_url || ''));
    item.appendChild(mkInputRow(`mcp-key-${i}`, 'server-key-val (laisser vide pour conserver)', '', 'password'));

    const statusRow = document.createElement('div');
    statusRow.className = 'settings-row';
    statusRow.style.justifyContent = 'space-between';
    statusRow.style.alignItems = 'center';

    const status = document.createElement('span');
    const connected = srv.last_status === 'ok';
    status.className = connected ? 'settings-conn-ok' : 'settings-conn-ko';
    status.textContent = connected ? '● Connecté' : '● Non connecté';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    const validateBtn = document.createElement('button');
    validateBtn.className = 'settings-btn';
    validateBtn.textContent = 'Valider la connexion';
    validateBtn.addEventListener('click', () => validateMcpServer(i));
    const removeBtn = document.createElement('button');
    removeBtn.className = 'settings-btn danger';
    removeBtn.textContent = 'Supprimer';
    removeBtn.addEventListener('click', () => removeMcpServerRow(i));
    actions.append(validateBtn, removeBtn);

    statusRow.append(status, actions);
    item.appendChild(statusRow);

    if (srv.last_error) {
      const err = document.createElement('div');
      err.className = 'settings-err';
      err.textContent = srv.last_error;
      item.appendChild(err);
    }

    const keyInfo = document.createElement('div');
    keyInfo.className = 'settings-desc';
    keyInfo.textContent = srv.has_api_key ? 'API key: enregistrée' : 'API key: absente';
    item.appendChild(keyInfo);

    const toolsInfo = document.createElement('div');
    toolsInfo.className = 'settings-desc';
    toolsInfo.textContent = `Tools: ${(srv.tools || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean).join(', ') || '—'}`;
    item.appendChild(toolsInfo);

    list.appendChild(item);
  });
}

function readMcpServerRow(index) {
  const current = _mcpServers[index] || {};
  return {
    ...current,
    server_label: document.getElementById(`mcp-label-${index}`)?.value?.trim() || '',
    server_url: document.getElementById(`mcp-url-${index}`)?.value?.trim() || '',
    api_key: document.getElementById(`mcp-key-${index}`)?.value?.trim() || '',
    has_api_key: Boolean(current.has_api_key)
  };
}

function addMcpServerRow() {
  _mcpServers.push({ server_label:'', server_url:'', api_key:'', has_api_key:false, tools:[], last_status:'unknown', last_error:'' });
  renderMcpServerRows();
}

function removeMcpServerRow(index) {
  _mcpServers.splice(index, 1);
  renderMcpServerRows();
}

async function validateMcpServer(index) {
  const row = readMcpServerRow(index);
  const msg = document.getElementById('s-mcp-msg');
  if (!row.server_label || !row.server_url || !row.api_key) {
    msg.className='settings-err'; msg.textContent='server_label, server_url et api_key sont obligatoires';
    return;
  }
  const res = await api('/api/auth/mcp-validate', 'POST', row);
  if (res.error) {
    _mcpServers[index] = { ...row, tools: [], has_api_key: row.has_api_key, last_status:'error', last_error: res.error };
    msg.className='settings-err'; msg.textContent=`${row.server_label}: ${res.error}`;
  } else {
    _mcpServers[index] = { ...row, api_key:'', has_api_key: true, tools: res.tools || [], last_status:'ok', last_error:'' };
    msg.className='settings-ok'; msg.textContent=`${row.server_label}: connexion établie (${res.count || 0} tools)`;
  }
  renderMcpServerRows();
  populateToolServerSelect();
  onToolMcpServerChange();
}

async function saveMcpServers() {
  const msg = document.getElementById('s-mcp-msg');
  _mcpServers = _mcpServers.map((_, i) => readMcpServerRow(i));
  const res = await api('/api/auth/mcp-servers', 'PUT', { mcp_servers: _mcpServers });
  if (res.error) {
    msg.className='settings-err'; msg.textContent=res.error;
    return;
  }
  _mcpServers = res.mcpServers || _mcpServers;
  msg.className='settings-ok'; msg.textContent='Registre MCP enregistré';
  renderMcpServerRows();
  populateToolServerSelect();
  onToolMcpServerChange();
}

function setLanguage(lang) {
  if (!['fr','en'].includes(lang)) return;
  const u = new URL(window.location.href);
  u.searchParams.set('lang', lang);
  window.location.href = u.toString();
}

function onSettingsProviderChange() {
  const p = document.getElementById('s-provider')?.value || 'anthropic';
  const el = document.getElementById('s-apikey');
  if (el) { el.value = ''; el.placeholder = PROVIDER_KEY_PLACEHOLDERS[p] || '…'; }
  updateKeyStatusIndicator();
}

async function loadProviderKeyStatus() {
  try {
    const data = await api('/api/auth/me', 'GET');
    if (data.providerKeys) {
      _providerKeyStatus = data.providerKeys;
      updateKeyStatusIndicator();
    }
    _mcpServers = Array.isArray(data.mcpServers) ? data.mcpServers : [];
    renderMcpServerRows();
    populateToolServerSelect();
    onToolMcpServerChange();
  } catch { /* ignore */ }
}

function updateKeyStatusIndicator() {
  const p = document.getElementById('s-provider')?.value || 'anthropic';
  const msg = document.getElementById('s-apikey-msg');
  if (!msg) return;
  if (_providerKeyStatus[p]) {
    msg.className = 'settings-ok';
    msg.textContent = `✓ Clé enregistrée pour ${p}`;
  } else {
    msg.className = '';
    msg.textContent = '';
  }
}

async function saveApiKey() {
  const provider = document.getElementById('s-provider')?.value || 'anthropic';
  const key = document.getElementById('s-apikey').value.trim();
  const msg = document.getElementById('s-apikey-msg');
  if (!key) { msg.className='settings-err'; msg.textContent='Enter an API key'; return; }
  const res = await api('/api/auth/apikey','PUT',{ provider, apiKey:key });
  if (res.error) { msg.className='settings-err'; msg.textContent=res.error; }
  else {
    _providerKeyStatus[provider] = true;
    document.getElementById('s-apikey').value='';
    updateKeyStatusIndicator();
  }
}

async function deleteApiKey() {
  const provider = document.getElementById('s-provider')?.value || 'anthropic';
  const msg = document.getElementById('s-apikey-msg');
  const res = await api('/api/auth/apikey','DELETE',{ provider });
  if (res.error) { msg.className='settings-err'; msg.textContent=res.error; }
  else {
    _providerKeyStatus[provider] = false;
    updateKeyStatusIndicator();
  }
}

async function changePassword() {
  const currentPassword=document.getElementById('s-oldpw').value, newPassword=document.getElementById('s-newpw').value;
  const msg=document.getElementById('s-pw-msg');
  const res=await api('/api/auth/password','PUT',{ currentPassword,newPassword });
  if(res.error){ msg.className='settings-err'; msg.textContent=res.error; }
  else { msg.className='settings-ok'; msg.textContent='Password updated'; }
}

// ── MODAL HELPERS ────────────────────────────────────────────────
function openModal(title,bodyHtml,actions=[]) {
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-body').innerHTML=bodyHtml;
  const actEl=document.getElementById('modal-actions'); actEl.innerHTML='';
  actions.forEach(a=>{ const btn=document.createElement('button'); btn.className='modal-btn'+(a.primary?' primary':''); btn.textContent=a.label; btn.onclick=a.action; actEl.appendChild(btn); });
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function openConfirm(title,sub,onConfirm) {
  const safeTitle = escapeHtml(title);
  const safeSub = escapeHtml(sub);
  openModal(title,`<div class="confirm-text">${safeTitle}</div><div class="confirm-sub">${safeSub}</div>`,[
    { label:'Cancel', action:closeModal },
    { label:'Delete', action:onConfirm }
  ]);
  document.querySelector('.modal-btn:last-child').classList.add('danger');
}

function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

// ── TOAST ────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg,type='ok') {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className=`show ${type}`;
  clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>(el.className=''),2500);
}

// ── WINDOW EXPORTS ───────────────────────────────────────────────
// FIX #11 — copyWorkflowExecLogs et clearWorkflowExecLogs ajoutées
Object.assign(window,{
  doLogout, openSettings, saveWorkflow, downloadWorkflow, newWorkflow, importWorkflow,
  toggleLeft, toggleTheme, fitGraph, setLayout, duplicateWorkflow,
  openNewStepEditor, openStepEditor,
  applyStepEdit, deleteCurrentStep, closeEditor, switchEditorTab,
  addInputField, addOutputField, onTypeChange,
  toggleTechSection, toggleApiAdvancedSection, toggleToolAdvancedSection, toggleEditorMaximize,
  toggleSyspromptSection, toggleTemplateSection, startRightPanelResize,
  runStepOnly, runWorkflowFromHere, stopExecution, closeModal, showSignupCTA,
  confirmEdgeDelete, toggleWorkflowExecLogs, toggleRightPanel,
  copyWorkflowExecLogs, clearWorkflowExecLogs,
  deleteWorkflow, copyWfJson, applyWfJson, closeWfJson, onWfJsonInput, copyWfJsonByName,
  openJsonFullscreen, closeJsonFullscreen, jfsCopy, jfsApply, jfsValidate,
  saveApiKey, deleteApiKey, changePassword, switchSettingsTab, addMcpServerRow, removeMcpServerRow, validateMcpServer, saveMcpServers,
  onProviderChange, onSettingsProviderChange, onToolMcpServerChange, setLanguage,
  startWorkflowRename
});

// ── KEYBOARD ────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  if (e.key==='Escape') {
    if (!document.getElementById('json-fullscreen').classList.contains('hidden')) { closeJsonFullscreen(); return; }
    closeModal();
  }
  if ((e.ctrlKey||e.metaKey)&&e.key==='s') { e.preventDefault(); saveWorkflow(); }
});
document.getElementById('modal-overlay').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-overlay')) closeModal(); });

// ── INIT ─────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  document.getElementById('f-webpage-mode')?.addEventListener('change', () => onTypeChange());

  if (localStorage.getItem('wf_theme')==='light') {
    document.documentElement.classList.add('light');
    document.getElementById('btn-theme').textContent='☾';
  }

  try {
    const cfg = await fetch('/json_schemas/providers.json').then(r=>r.json());
    _providersConfig = cfg;
  } catch { /* fallback sur PROVIDER_MODEL_HINTS */ }

  initWorkflowLogsPanel();
  setRightPanelVisible(false);

  const root = createRoot(document.getElementById('rf-container'));
  root.render(h(AppGraph,null));

  const me=await api('/api/auth/me');
  if (!me.error) { enterAuthUser(me); return; }
  enterGuestMode(true);
});
