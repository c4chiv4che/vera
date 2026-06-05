import { useMemo, useRef, useEffect } from 'react'
import ReactFlow, {
  Background,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'

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

const ROW_HEIGHT = 96
const NODE_X = 40
const NODE_WIDTH = 280

function truncate(s, n = 80) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function TraceNode({ data }) {
  const { title, subtitle, colors, pulsing } = data
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: colors.border, width: 6, height: 6, border: 'none' }} />
      <div style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: '10px 14px',
        color: colors.text,
        fontSize: 13,
        width: NODE_WIDTH,
        boxShadow: pulsing ? `0 0 14px ${colors.border}99` : 'none',
        transition: 'box-shadow 200ms ease',
      }}>
        <div style={{ fontWeight: 500 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {subtitle}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: colors.border, width: 6, height: 6, border: 'none' }} />
    </>
  )
}

const nodeTypes = { trace: TraceNode }

function makeNode(id, y, title, subtitle, colors, pulsing = false) {
  return {
    id,
    type: 'trace',
    position: { x: NODE_X, y },
    data: { title, subtitle, colors, pulsing },
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
function buildGraph(traceLog) {
  const nodes = []
  const edges = []
  let y = 20
  let prevId = null

  for (const entry of traceLog) {
    if (entry.type === 'user_message') {
      const id = `u-${entry.seq}`
      nodes.push(makeNode(id, y, 'Usuario', truncate(entry.content, 100), COLORS.user))
      if (prevId) edges.push(makeEdge(prevId, id, true))
      prevId = id
      y += ROW_HEIGHT
    } else if (entry.type === 'assistant_message') {
      const streaming = entry.status === 'streaming'
      const bedrockId = `b-${entry.seq}`
      nodes.push(makeNode(bedrockId, y, 'Bedrock razona', '', COLORS.bedrock, streaming && !entry.content))
      if (prevId) edges.push(makeEdge(prevId, bedrockId, true))
      y += ROW_HEIGHT
      const respId = `r-${entry.seq}`
      nodes.push(makeNode(
        respId, y,
        streaming ? 'Respondiendo…' : 'Respuesta',
        truncate(entry.content, 140),
        COLORS.response,
        streaming
      ))
      edges.push(makeEdge(bedrockId, respId, true))
      prevId = respId
      y += ROW_HEIGHT
    } else if (entry.type === 'tool_call') {
      const running = entry.status === 'running'
      const bedrockId = `b-${entry.seq}`
      nodes.push(makeNode(bedrockId, y, 'Bedrock razona', '', COLORS.bedrock))
      if (prevId) edges.push(makeEdge(prevId, bedrockId, true))
      y += ROW_HEIGHT
      const toolId = `t-${entry.seq}`
      const toolColors = running ? COLORS.tool_run : COLORS.tool_done
      nodes.push(makeNode(
        toolId, y,
        `Tool: ${entry.toolName}`,
        truncate(entry.args, 80),
        toolColors,
        running
      ))
      edges.push(makeEdge(bedrockId, toolId, true))
      y += ROW_HEIGHT
      prevId = toolId
      if (entry.status === 'done' && entry.result !== null) {
        const resId = `res-${entry.seq}`
        const { label, detail, colors } = formatResult(entry.result)
        nodes.push(makeNode(resId, y, label, detail, colors))
        edges.push(makeEdge(toolId, resId, true))
        prevId = resId
        y += ROW_HEIGHT
      }
    } else if (entry.type === 'error') {
      const id = `e-${entry.seq}`
      nodes.push(makeNode(id, y, 'Error', truncate(entry.detail, 120), COLORS.error))
      if (prevId) edges.push(makeEdge(prevId, id, true))
      prevId = id
      y += ROW_HEIGHT
    }
    // run_started, run_finished, metrics, unknown, STATE_SNAPSHOT/MESSAGES_SNAPSHOT
    // (the last two never reach traceLog) are intentionally not nodes here.
  }

  return { nodes, edges }
}

// threadId="vera-demo" (BFF constant, bff/index.js:10) marks text;
// anything else (banking-voice-<hex>, etc.) marks voice.
function sessionLabel(traceLog) {
  const first = traceLog.find((e) => e.type === 'run_started')
  if (!first) return null
  const isText = first.threadId === 'vera-demo'
  return {
    kind: isText ? 'texto' : 'voz',
    threadId: first.threadId,
  }
}

function TraceGraphInner({ traceLog }) {
  const { setViewport } = useReactFlow()
  const containerRef = useRef(null)
  const { nodes, edges } = useMemo(() => buildGraph(traceLog), [traceLog])
  const session = useMemo(() => sessionLabel(traceLog), [traceLog])

  // Pan downward as new nodes arrive so the latest is in view, without ever
  // changing zoom (per scope: "SIN zoom elaborado"). Re-rendering an existing
  // entry (delta coalescing into an open assistant_message) shouldn't yank
  // the viewport — so deps intentionally ignore `nodes` and key on length.
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return
    const h = containerRef.current.clientHeight || 600
    const lastY = nodes[nodes.length - 1].position.y
    const targetY = Math.min(0, h * 0.7 - lastY)
    setViewport({ x: 0, y: targetY, zoom: 1 }, { duration: 350 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, setViewport])

  return (
    <div ref={containerRef} className="flex-1 relative">
      {session && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/80 border border-slate-700 text-xs font-mono">
          <span className={session.kind === 'voz' ? 'text-violet-400' : 'text-cyan-400'}>
            sesión {session.kind}
          </span>
          <span className="text-slate-500">·</span>
          <span className="text-slate-400">{session.threadId}</span>
        </div>
      )}
      {nodes.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-slate-600 text-sm">Esperando primer evento de Vera…</p>
        </div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          panOnScroll={true}
          panOnDrag={true}
          minZoom={1}
          maxZoom={1}
          proOptions={{ hideAttribution: true }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        >
          <Background gap={32} size={1} color="#1e293b" />
        </ReactFlow>
      )}
    </div>
  )
}

export default function TraceGraph({ traceLog }) {
  return (
    <ReactFlowProvider>
      <TraceGraphInner traceLog={traceLog} />
    </ReactFlowProvider>
  )
}
