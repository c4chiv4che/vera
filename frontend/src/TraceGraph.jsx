import { useMemo, useRef, useEffect } from 'react'
import ReactFlow, {
  Background,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { buildGraph } from './traceGraphBuild'

const NODE_WIDTH = 280

function TraceNode({ data }) {
  const { title, subtitle, arch, colors, pulsing } = data
  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: colors.border, width: 6, height: 6, border: 'none' }} />
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
        {arch && (
          <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2, letterSpacing: '0.5px' }}>
            {arch}
          </div>
        )}
        {subtitle && (
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {subtitle}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: colors.border, width: 6, height: 6, border: 'none' }} />
    </>
  )
}

const nodeTypes = { trace: TraceNode }

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

  // Pan rightward as new nodes arrive so the latest is in view, without
  // changing zoom (per scope: "SIN zoom elaborado"). Re-rendering an existing
  // entry (delta coalescing into an open assistant_message) shouldn't yank
  // the viewport — so deps intentionally ignore `nodes` and key on length.
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return
    const w = containerRef.current.clientWidth || 1200
    const lastX = nodes[nodes.length - 1].position.x
    const targetX = Math.min(0, w * 0.7 - lastX)
    setViewport({ x: targetX, y: 0, zoom: 1 }, { duration: 350 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, setViewport])

  return (
    <div ref={containerRef} className="relative h-[74vh]">
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
