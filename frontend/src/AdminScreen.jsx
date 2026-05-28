const METRICS = [
  { label: 'Atendidos hoy', value: 37, icon: 'M3 12h4l3 8 4-16 3 8h4', spark: [12,18,15,22,28,25,31,37], tone: 'normal' },
  { label: 'Escalados a humano', value: 6, icon: 'M16 11a4 4 0 1 0-8 0M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2', spark: [2,3,3,4,4,5,5,6], tone: 'normal' },
  { label: 'Tiempo medio', value: '1m 32s', icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', spark: [110,98,105,92,95,88,90,92], tone: 'normal', raw: true },
]

const RESOLVED = 31
const TOTAL = 37
const PCT = Math.round((RESOLVED / TOTAL) * 100)

const CONVERSATIONS = [
  { initials: 'MR', name: 'Martín R.', task: 'Turno con cardiología agendado', icon: 'M12 21C7 17 3 13 3 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 2.5C21 13 17 17 12 21z', mood: 'tranquilo', status: 'resuelto', tone: 'good' },
  { initials: 'LF', name: 'Lucía F.', task: 'Consulta de historial clínico', icon: 'M9 12h6M9 16h6M9 8h6M5 3h14v18H5z', mood: 'tranquila', status: 'en curso', tone: 'good' },
  { initials: 'JP', name: 'Jorge P.', task: 'Nuevo turno · clínica general', icon: 'M8 2v4M16 2v4M3 10h18M5 4h14v16H5z', mood: 'neutral', status: 'en curso', tone: 'neutral' },
  { initials: 'DA', name: 'Diego A.', task: 'Reprogramar turno · dermatología', icon: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2', mood: 'tranquilo', status: 'en curso', tone: 'good' },
  { initials: 'ES', name: 'Elena S.', task: 'Llamó por resultados de un estudio · pide hablar con una persona', icon: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', mood: 'angustiada', status: 'intervenir', tone: 'alert' },
]

const TONE = {
  good:    { dot: '#34d399', pill: 'bg-emerald-500/15 text-emerald-300', avatar: 'bg-emerald-500/15 text-emerald-300' },
  neutral: { dot: '#94a3b8', pill: 'bg-slate-500/15 text-slate-300', avatar: 'bg-slate-700/40 text-slate-300' },
  alert:   { dot: '#f87171', pill: 'bg-red-500/20 text-red-300', avatar: 'bg-red-500/20 text-red-300' },
}

function Sparkline({ data, color }) {
  const w = 90, h = 28
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const d = `M ${pts.join(' L ')}`
  const area = `${d} L ${w},${h} L 0,${h} Z`
  return (
    <svg width={w} height={h} className="mt-2">
      <path d={area} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Ring({ pct, color }) {
  const r = 42, c = 2 * Math.PI * r
  const off = c - (pct / 100) * c
  return (
    <svg width="110" height="110" viewBox="0 0 110 110">
      <circle cx="55" cy="55" r={r} fill="none" stroke="#1e293b" strokeWidth="9" />
      <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 55 55)" />
      <text x="55" y="52" textAnchor="middle" fontSize="26" fontWeight="600" fill="#e6eaf2">{pct}%</text>
      <text x="55" y="70" textAnchor="middle" fontSize="10" fill="#94a3b8">sin humano</text>
    </svg>
  )
}

function Icon({ d, className }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={d} />
    </svg>
  )
}

function Metric({ label, value, icon, spark, raw }) {
  return (
    <div className="rounded-2xl p-5 bg-slate-900/50 border border-slate-800/80" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <span className="text-slate-500"><Icon d={icon} /></span>
      </div>
      <p className="text-3xl font-semibold mt-1 text-slate-100">{value}</p>
      <Sparkline data={spark} color="#5eead4" />
    </div>
  )
}

function Row({ c }) {
  const isAlert = c.tone === 'alert'
  const t = TONE[c.tone]
  return (
    <div className={`flex items-center gap-4 rounded-2xl px-5 py-4 ${
      isAlert ? 'bg-red-500/10 border-2 border-red-500/50 animate-[alertpulse_2s_ease-in-out_infinite]' : 'bg-slate-900/40 border border-slate-800'
    }`} style={!isAlert ? { boxShadow: '0 2px 16px rgba(0,0,0,0.2)' } : {}}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${t.avatar}`}>
        {c.initials}
      </div>
      <span className={isAlert ? 'text-red-400 shrink-0' : 'text-slate-500 shrink-0'}><Icon d={c.icon} /></span>
      <div className="flex-1 min-w-0">
        <p className="font-medium flex items-center gap-2">{c.name}</p>
        <p className={`text-sm truncate ${isAlert ? 'text-red-300/80' : 'text-slate-500'}`}>{c.task}</p>
      </div>
      <span className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full shrink-0 ${t.pill}`}>
        <span className="w-2 h-2 rounded-full" style={{ background: t.dot }}></span>
        {c.mood}
      </span>
      {isAlert ? (
        <button className="text-xs px-4 py-2 rounded-full border border-red-500/60 text-red-200 bg-red-500/15 hover:bg-red-500/25 transition-colors shrink-0">
          intervenir
        </button>
      ) : (
        <span className="text-xs text-slate-500 w-20 text-right shrink-0">{c.status}</span>
      )}
    </div>
  )
}

export default function AdminScreen({ go }) {
  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e15]">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800">
        <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        <span className="text-sm font-mono text-amber-400">04</span>
        <span className="text-lg font-medium">Panel de control</span>
        <span className="ml-auto text-sm text-slate-500">5 conversaciones activas</span>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="rounded-2xl p-5 bg-emerald-500/[0.07] border border-emerald-500/25 flex items-center gap-4" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}>
              <Ring pct={PCT} color="#34d399" />
              <div>
                <p className="text-sm text-slate-300">Resueltos sin humano</p>
                <p className="text-xs text-slate-500 mt-1">{RESOLVED} de {TOTAL} hoy</p>
              </div>
            </div>
            {METRICS.map((m) => <Metric key={m.label} {...m} />)}
          </div>

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-medium text-slate-300">Conversaciones en curso</h2>
            <span className="flex items-center gap-2 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>en vivo
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {CONVERSATIONS.map((c) => <Row key={c.initials} c={c} />)}
          </div>

          <p className="text-center text-xs text-slate-600 mt-8">
            Vera deriva a un humano cuando detecta angustia o un caso que excede su alcance.
          </p>
        </div>
      </div>
    </div>
  )
}
