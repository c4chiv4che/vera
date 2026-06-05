// Pure data layer for TraceGraph: walk a traceLog and produce ReactFlow
// nodes/edges. Lives in its own file because TraceGraph.jsx exports only
// React components — co-exporting buildGraph from there breaks Vite Fast
// Refresh (react-refresh/only-export-components). Same split rationale as
// useAgent.js vs AgentContext.jsx.

// Visual language stays in slate/cyan; tool/result use the same amber/green
// pair that FlowScreen's map already uses for tool nodes, so a viewer
// toggling Mapa ↔ Trace recognises the same palette.
const COLORS = {
  user:      { bg: '#1b2333', border: '#64748b', text: '#cbd5e1' },
  bedrock:   { bg: '#0e2230', border: '#5cd0e0', text: '#bfefff' },
  tool_run:  { bg: '#2a1d0a', border: '#e0a020', text: '#f7e0a8' },
  tool_done: { bg: '#33240a', border: '#b88720', text: '#d8c08a' },
  result_ok: { bg: '#0e2a1a', border: '#27d07a', text: '#a6f5cd' },
  result_no: { bg: '#33240a', border: '#e0a020', text: '#f7e0a8' },
  response:  { bg: '#0e2230', border: '#5cd0e0', text: '#bfefff' },
  error:     { bg: '#3a1010', border: '#e05050', text: '#ffa0a0' },
}

// Horizontal flow: nodes step right by COL_STEP, all share NODE_Y.
// COL_STEP = NODE_WIDTH (280, set in TraceGraph.jsx) + 40 gap.
// NODE_Y leaves room above for the absolute session chip.
const X_START = 40
const COL_STEP = 320
const NODE_Y = 200

// Mirrors the architecture sublabel each tool gets in FlowScreen's map
// (NODES[].svc). Duplicated here intentionally: the real source of truth
// is the per-industry agent manifest (agent/app/vera/industries/…), and
// surfacing that in the frontend is a separate decision. Three lines of
// duplication today is cheaper than premature centralisation.
const TOOL_ARCHITECTURE = {
  identificar_cliente: 'Lambda · DynamoDB',
  consultar_perfil_crediticio: 'Lambda · DynamoDB',
  evaluar_prestamo: 'Lambda · DynamoDB',
}

function truncate(s, n = 80) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function makeNode(id, x, title, subtitle, colors, pulsing = false, arch = undefined) {
  return {
    id,
    type: 'trace',
    position: { x, y: NODE_Y },
    data: { title, subtitle, arch, colors, pulsing },
    draggable: false,
    selectable: false,
  }
}

function makeEdge(source, target, lit) {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: 'smoothstep',
    style: { stroke: lit ? '#5cd0e0' : '#3b4658', strokeWidth: 1.5 },
  }
}

function formatResult(r) {
  if (!r || typeof r !== 'object') return { label: 'Resultado', detail: '', colors: COLORS.result_ok }
  if (r.decision) {
    const dti = r.dti_resultante_pct !== undefined ? ` · DTI ${r.dti_resultante_pct}%` : ''
    if (r.decision === 'aprobado') return { label: 'Resultado · aprobado', detail: dti.trim().slice(2), colors: COLORS.result_ok }
    return { label: `Resultado · ${r.decision}`, detail: dti.trim().slice(2), colors: COLORS.result_no }
  }
  if (r.identificado && r.nombre) {
    return { label: 'Resultado', detail: `${r.nombre} ✓`, colors: COLORS.result_ok }
  }
  return { label: 'Resultado', detail: truncate(JSON.stringify(r), 80), colors: COLORS.result_ok }
}

// Walk the traceLog once and produce ReactFlow nodes/edges.
// run_started / run_finished / metrics / unknown / snapshots are skipped here;
// the session chip above the canvas summarises run-level info instead.
//
// User and assistant message nodes are intentionally bare (no body text):
// the demo proof lives in the tool args + decision/DTI, not in the
// conversation transcript (that's what the Conversación screen is for).
export function buildGraph(traceLog) {
  const nodes = []
  const edges = []
  let x = X_START
  let prevId = null

  for (const entry of traceLog) {
    if (entry.type === 'user_message') {
      const id = `u-${entry.seq}`
      nodes.push(makeNode(id, x, 'Usuario', '', COLORS.user))
      if (prevId) edges.push(makeEdge(prevId, id, true))
      prevId = id
      x += COL_STEP
    } else if (entry.type === 'assistant_message') {
      const streaming = entry.status === 'streaming'
      const bedrockId = `b-${entry.seq}`
      nodes.push(makeNode(bedrockId, x, 'Bedrock razona', '', COLORS.bedrock, streaming && !entry.content))
      if (prevId) edges.push(makeEdge(prevId, bedrockId, true))
      x += COL_STEP
      const respId = `r-${entry.seq}`
      nodes.push(makeNode(
        respId, x,
        streaming ? 'Respondiendo…' : 'Respuesta',
        '',
        COLORS.response,
        streaming
      ))
      edges.push(makeEdge(bedrockId, respId, true))
      prevId = respId
      x += COL_STEP
    } else if (entry.type === 'tool_call') {
      const running = entry.status === 'running'
      const bedrockId = `b-${entry.seq}`
      nodes.push(makeNode(bedrockId, x, 'Bedrock razona', '', COLORS.bedrock))
      if (prevId) edges.push(makeEdge(prevId, bedrockId, true))
      x += COL_STEP
      const toolId = `t-${entry.seq}`
      const toolColors = running ? COLORS.tool_run : COLORS.tool_done
      nodes.push(makeNode(
        toolId, x,
        `Tool: ${entry.toolName}`,
        truncate(entry.args, 80),
        toolColors,
        running,
        TOOL_ARCHITECTURE[entry.toolName]
      ))
      edges.push(makeEdge(bedrockId, toolId, true))
      x += COL_STEP
      prevId = toolId
      if (entry.status === 'done' && entry.result !== null) {
        const resId = `res-${entry.seq}`
        const { label, detail, colors } = formatResult(entry.result)
        nodes.push(makeNode(resId, x, label, detail, colors))
        edges.push(makeEdge(toolId, resId, true))
        prevId = resId
        x += COL_STEP
      }
    } else if (entry.type === 'error') {
      const id = `e-${entry.seq}`
      nodes.push(makeNode(id, x, 'Error', truncate(entry.detail, 120), COLORS.error))
      if (prevId) edges.push(makeEdge(prevId, id, true))
      prevId = id
      x += COL_STEP
    }
    // run_started, run_finished, metrics, unknown, STATE_SNAPSHOT/MESSAGES_SNAPSHOT
    // (the last two never reach traceLog) are intentionally not nodes here.
  }

  return { nodes, edges }
}
