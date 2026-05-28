import { useAgent } from './AgentContext'

const NODES = [
  { id: 'voz',         x: 290, y: 30,  w: 180, h: 50, label: 'Voz del cliente',    svc: '',                  hint: 'próximamente · etapa Connect', type: 'io',   disabled: true },
  { id: 'transcribir', x: 275, y: 120, w: 210, h: 60, label: 'Transcribir',         svc: 'Amazon Transcribe', hint: 'próximamente · etapa Connect', type: 'proc', disabled: true },
  { id: 'identificar', x: 275, y: 212, w: 210, h: 60, label: 'Identificar cliente', svc: 'Lambda · DynamoDB',                                       type: 'proc' },
  { id: 'bedrock',     x: 305, y: 304, w: 150, h: 90, label: 'Bedrock',             svc: 'razona',                                                  type: 'decision' },
  { id: 'perfil',      x: 55,  y: 426, w: 215, h: 60, label: 'Consultar perfil',    svc: 'Lambda · DynamoDB',                                       type: 'tool' },
  { id: 'evaluar',     x: 490, y: 426, w: 215, h: 60, label: 'Evaluar préstamo',    svc: 'Lambda · DynamoDB',                                       type: 'tool' },
  { id: 'responder',   x: 290, y: 530, w: 180, h: 50, label: 'Responder con voz',   svc: 'Amazon Polly',      hint: 'próximamente · etapa Connect', type: 'io',   disabled: true },
]

const EDGES = [
  { from: 'voz',         to: 'transcribir' },
  { from: 'transcribir', to: 'identificar' },
  { from: 'identificar', to: 'bedrock' },
  { from: 'bedrock',     to: 'perfil' },
  { from: 'bedrock',     to: 'evaluar' },
  { from: 'perfil',      to: 'responder' },
  { from: 'evaluar',     to: 'responder' },
]

const TYPE_COLORS = {
  io:       { fill: '#0e2a1a', stroke: '#27d07a', text: '#a6f5cd', svc: '#5fbf8e', glow: '#27d07a' },
  proc:     { fill: '#0d2138', stroke: '#2f7fd4', text: '#cfe4f8', svc: '#6b9fd0', glow: '#2f7fd4' },
  decision: { fill: '#241430', stroke: '#b14fd6', text: '#ecc9f7', svc: '#bb86d8', glow: '#b14fd6' },
  tool:     { fill: '#33240a', stroke: '#e0a020', text: '#f7e0a8', svc: '#c9a456', glow: '#e0a020' },
}

const TOOL_BY_NODE = {
  identificar: 'identificar_cliente',
  perfil:      'consultar_perfil_crediticio',
  evaluar:     'evaluar_prestamo',
}

function nodeCenter(n) { return { cx: n.x + n.w / 2, cy: n.y + n.h / 2 } }
function edgePath(a, b) {
  const A = nodeCenter(a), B = nodeCenter(b)
  const startY = a.y + a.h, endY = b.y
  const midY = (startY + endY) / 2
  return `M ${A.cx} ${startY} C ${A.cx} ${midY}, ${B.cx} ${midY}, ${B.cx} ${endY}`
}

function statusOf(nodeId, toolCalls, isRunning) {
  const node = NODES.find((n) => n.id === nodeId)
  if (node?.disabled) return 'disabled'
  if (nodeId === 'bedrock') {
    if (isRunning || toolCalls.some((tc) => tc.status === 'running')) return 'running'
    if (toolCalls.length > 0) return 'done'
    return 'idle'
  }
  const toolName = TOOL_BY_NODE[nodeId]
  if (!toolName) return 'idle'
  const matches = toolCalls.filter((tc) => tc.name === toolName)
  if (matches.length === 0) return 'idle'
  return matches[matches.length - 1].status === 'done' ? 'done' : 'running'
}

function dataOf(nodeId, toolCalls) {
  const toolName = TOOL_BY_NODE[nodeId]
  if (!toolName) return null
  const matches = toolCalls.filter((tc) => tc.name === toolName && tc.status === 'done')
  const latest = matches[matches.length - 1]
  if (!latest?.result) return null
  const r = latest.result
  if (nodeId === 'identificar' && r.identificado) {
    return { text: `${r.nombre} ✓`, color: '#a6f5cd' }
  }
  if (nodeId === 'evaluar' && r.decision) {
    const dti = r.dti_resultante_pct
    if (r.decision === 'aprobado') return { text: `Aprobado · DTI ${dti}%`, color: '#27d07a' }
    return { text: `Derivado · DTI ${dti}%`, color: '#e0a020' }
  }
  return null
}

export default function FlowScreen({ go, monitorMode }) {
  const { toolCalls, isRunning, conversationState, reset } = useAgent()
  const nodeById = (id) => NODES.find((n) => n.id === id)

  const headerStatus = isRunning
    ? 'Bedrock está razonando…'
    : conversationState === 'escalated' ? 'Caso derivado a un asesor humano'
    : conversationState === 'resolved'  ? 'Caso resuelto por Vera'
    : 'lo que pasa por detrás mientras Vera atiende'

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e15]">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800 z-10">
        {!monitorMode && (
          <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        )}
        <span className="text-sm font-mono text-violet-400">02</span>
        <span className="text-lg font-medium">Orquestación en vivo</span>
        <span className="ml-auto text-sm text-slate-500">{headerStatus}</span>
      </header>

      <div className="flex-1 flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
        }} />
        <svg viewBox="0 0 760 610" className="w-full h-full max-w-4xl relative" style={{ maxHeight: '74vh' }}>
          <defs>
            {Object.entries(TYPE_COLORS).map(([k, c]) => (
              <filter key={k} id={`glow-${k}`} x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="4" result="b1" />
                <feGaussianBlur stdDeviation="9" result="b2" />
                <feMerge><feMergeNode in="b2" /><feMergeNode in="b1" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            ))}
          </defs>

          {EDGES.map((e, i) => {
            const a = nodeById(e.from), b = nodeById(e.to)
            const target = statusOf(e.to, toolCalls, isRunning)
            const flowing = target === 'running'
            const lit = target === 'done'
            const d = edgePath(a, b)
            return (
              <g key={i}>
                <path d={d} fill="none"
                  stroke={lit || flowing ? '#5cd0e0' : '#243042'}
                  strokeWidth={flowing ? 2.5 : 1.5}
                  opacity={lit || flowing ? 0.9 : 1} />
                {flowing && (
                  <circle r="4" fill="#bfefff">
                    <animateMotion dur="0.9s" repeatCount="indefinite" path={d} />
                    <animate attributeName="opacity" values="0;1;1;0" dur="0.9s" repeatCount="indefinite" />
                  </circle>
                )}
              </g>
            )
          })}

          {NODES.map((n) => {
            const c = TYPE_COLORS[n.type]
            const status = statusOf(n.id, toolCalls, isRunning)
            const data = dataOf(n.id, toolCalls)
            const isActive = status === 'running'
            const isReached = status === 'done'
            const isDisabled = status === 'disabled'
            const opacity = isDisabled ? 0.35 : (isReached || isActive ? 1 : 0.28)
            const { cx, cy } = nodeCenter(n)
            const lift = isActive ? -3 : 0

            const inner = n.type === 'decision' ? (() => {
              const r = 46
              return (
                <>
                  <polygon points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
                    fill={c.fill} stroke={c.stroke} strokeWidth={isActive ? 2.2 : 1.3} />
                  <text x={cx} y={cy - 3} textAnchor="middle" fontSize="15" fontWeight="500" fill={c.text}>{n.label}</text>
                  <text x={cx} y={cy + 15} textAnchor="middle" fontSize="11" fill={c.svc}>{n.svc}</text>
                </>
              )
            })() : (
              <>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.type === 'io' ? n.h / 2 : 12}
                  fill={c.fill} stroke={c.stroke} strokeWidth={isActive ? 2.2 : 1.3} />
                <text x={cx} y={n.svc ? n.y + n.h / 2 - 7 : cy + 1} textAnchor="middle" dominantBaseline="central" fontSize="15" fontWeight="500" fill={c.text}>{n.label}</text>
                {n.svc && <text x={cx} y={n.y + n.h / 2 + 12} textAnchor="middle" dominantBaseline="central" fontSize="10.5" letterSpacing="0.5" fill={c.svc}>{n.svc}</text>}
              </>
            )

            return (
              <g key={n.id}>
                <g filter={isActive ? `url(#glow-${n.type})` : undefined}
                  style={{ opacity, transition: 'opacity 0.5s, transform 0.4s', transform: `translateY(${lift}px)` }}>
                  {inner}
                </g>
                {n.hint && (
                  <text x={cx} y={n.y + n.h + 14} textAnchor="middle" fontSize="9.5" fill="#5a6577" letterSpacing="0.4">{n.hint}</text>
                )}
                {data && (
                  <text x={cx} y={n.y + n.h + 14} textAnchor="middle" fontSize="11" fontWeight="500" fill={data.color} letterSpacing="0.3">{data.text}</text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      <div className="flex justify-center pb-10">
        <button onClick={reset} className="text-sm px-5 py-2 rounded-full border border-slate-700 text-slate-400 hover:text-white transition-colors">↺ reiniciar</button>
      </div>
    </div>
  )
}
