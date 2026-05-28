import { useState, useEffect, useRef } from 'react'

const NODES = [
  { id: 'voice',    x: 290, y: 30,  w: 180, h: 50, label: 'Voz del paciente', svc: '', type: 'io' },
  { id: 'stt',      x: 275, y: 120, w: 210, h: 60, label: 'Transcribir', svc: 'Amazon Transcribe', type: 'proc' },
  { id: 'identify', x: 275, y: 212, w: 210, h: 60, label: 'Identificar paciente', svc: 'Amazon Connect', type: 'proc' },
  { id: 'bedrock',  x: 305, y: 304, w: 150, h: 90, label: 'Bedrock', svc: 'razona', type: 'decision' },
  { id: 'appt',     x: 55,  y: 426, w: 215, h: 60, label: 'Buscar turno', svc: 'AWS Lambda · DynamoDB', type: 'tool' },
  { id: 'history',  x: 490, y: 426, w: 215, h: 60, label: 'Revisar historial', svc: 'AWS Lambda · DynamoDB', type: 'tool' },
  { id: 'respond',  x: 290, y: 530, w: 180, h: 50, label: 'Responder con voz', svc: 'Amazon Polly', type: 'io' },
]

const EDGES = [
  { from: 'voice', to: 'stt' },
  { from: 'stt', to: 'identify' },
  { from: 'identify', to: 'bedrock' },
  { from: 'bedrock', to: 'appt' },
  { from: 'bedrock', to: 'history' },
  { from: 'appt', to: 'respond' },
  { from: 'history', to: 'respond' },
]

const SEQUENCE = [
  { node: 'voice',    label: 'Martín habla — entra el audio', ms: 1800 },
  { node: 'stt',      label: 'Transcribiendo la voz a texto', ms: 1800 },
  { node: 'identify', label: 'Paciente identificado: Martín', ms: 1800 },
  { node: 'bedrock',  label: 'Bedrock interpreta la intención', ms: 2000 },
  { node: 'appt',     label: 'Consultando la agenda del Dr. Ramírez', ms: 2200 },
  { node: 'respond',  label: 'Vera ofrece alternativas de turno', ms: 2000 },
  { node: 'bedrock',  label: 'Bedrock evalúa proactivamente el historial', ms: 2000 },
  { node: 'history',  label: 'Encuentra el recordatorio de cardiología', ms: 2200 },
  { node: 'respond',  label: 'Vera sugiere agendar con cardiología', ms: 2200 },
]

const TYPE_COLORS = {
  io:       { fill: '#0e2a1a', stroke: '#27d07a', text: '#a6f5cd', svc: '#5fbf8e', glow: '#27d07a' },
  proc:     { fill: '#0d2138', stroke: '#2f7fd4', text: '#cfe4f8', svc: '#6b9fd0', glow: '#2f7fd4' },
  decision: { fill: '#241430', stroke: '#b14fd6', text: '#ecc9f7', svc: '#bb86d8', glow: '#b14fd6' },
  tool:     { fill: '#33240a', stroke: '#e0a020', text: '#f7e0a8', svc: '#c9a456', glow: '#e0a020' },
}

function nodeCenter(n) { return { cx: n.x + n.w / 2, cy: n.y + n.h / 2 } }
function edgePath(a, b) {
  const A = nodeCenter(a), B = nodeCenter(b)
  const startY = a.y + a.h, endY = b.y
  const midY = (startY + endY) / 2
  return `M ${A.cx} ${startY} C ${A.cx} ${midY}, ${B.cx} ${midY}, ${B.cx} ${endY}`
}

export default function FlowScreen({ go }) {
  const [activeIdx, setActiveIdx] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [reached, setReached] = useState(new Set())
  const timer = useRef(null)

  useEffect(() => {
    if (!playing) return
    if (activeIdx >= SEQUENCE.length - 1) { setPlaying(false); return }
    const next = activeIdx + 1
    timer.current = setTimeout(() => {
      setActiveIdx(next)
      setReached((prev) => new Set(prev).add(SEQUENCE[next].node))
    }, activeIdx < 0 ? 500 : SEQUENCE[activeIdx].ms)
    return () => clearTimeout(timer.current)
  }, [playing, activeIdx])

  function start() { setActiveIdx(-1); setReached(new Set()); setPlaying(true) }
  function reset() { clearTimeout(timer.current); setPlaying(false); setActiveIdx(-1); setReached(new Set()) }

  const activeNode = activeIdx >= 0 ? SEQUENCE[activeIdx].node : null
  const nodeById = (id) => NODES.find((n) => n.id === id)

  function edgeActive(e) {
    if (activeIdx < 0) return false
    const cur = SEQUENCE[activeIdx].node
    const prev = activeIdx > 0 ? SEQUENCE[activeIdx - 1].node : null
    return (e.from === prev && e.to === cur)
  }
  function edgeLit(e) { return reached.has(e.from) && reached.has(e.to) }

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e15]">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800 z-10">
        <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        <span className="text-sm font-mono text-violet-400">02</span>
        <span className="text-lg font-medium">Orquestación en vivo</span>
        <span className="ml-auto text-sm text-slate-500">
          {activeIdx >= 0 ? SEQUENCE[activeIdx].label : 'lo que pasa por detrás mientras Vera atiende'}
        </span>
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
            const lit = edgeLit(e), flowing = edgeActive(e)
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
            const isActive = activeNode === n.id
            const isReached = reached.has(n.id)
            const opacity = isReached || isActive ? 1 : 0.28
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
              <g key={n.id} filter={isActive ? `url(#glow-${n.type})` : undefined}
                style={{ opacity, transition: 'opacity 0.5s, transform 0.4s', transform: `translateY(${lift}px)` }}>
                {inner}
              </g>
            )
          })}
        </svg>
      </div>

      <div className="flex justify-center pb-10">
        {!playing && activeIdx < 0 && (
          <button onClick={start} className="text-sm px-5 py-2 rounded-full border border-violet-500/50 text-violet-100 bg-violet-500/15 hover:bg-violet-500/25 transition-colors">▶ reproducir orquestación</button>
        )}
        {(playing || activeIdx >= 0) && (
          <button onClick={reset} className="text-sm px-5 py-2 rounded-full border border-slate-700 text-slate-400 hover:text-white transition-colors">↺ reiniciar</button>
        )}
      </div>
    </div>
  )
}
