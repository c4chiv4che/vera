import { useAgent } from './useAgent'

const AGENT_STATUS_STYLE = {
  AVAILABLE:          { label: 'AVAILABLE',          pill: 'bg-emerald-500/15 text-emerald-300', dot: '#34d399' },
  ON_CONTACT:         { label: 'ON CONTACT',         pill: 'bg-sky-500/15 text-sky-300',         dot: '#38bdf8' },
  AFTER_CONTACT_WORK: { label: 'AFTER CONTACT WORK', pill: 'bg-amber-500/15 text-amber-300',     dot: '#f59e0b' },
  NON_PRODUCTIVE:     { label: 'NON PRODUCTIVE',     pill: 'bg-slate-700/40 text-slate-300',     dot: '#94a3b8' },
}

const CONTACT_STATE_STYLE = {
  identifying: { label: 'Identificando',      pill: 'bg-sky-500/15 text-sky-300' },
  consulting:  { label: 'Consultando perfil', pill: 'bg-violet-500/15 text-violet-300' },
  evaluating:  { label: 'Evaluando préstamo', pill: 'bg-amber-500/15 text-amber-300' },
  resolved:    { label: 'Resuelto',           pill: 'bg-emerald-500/15 text-emerald-300' },
  escalated:   { label: 'Derivado',           pill: 'bg-red-500/20 text-red-300' },
  in_queue:    { label: 'En espera',          pill: 'bg-slate-700/40 text-slate-300' },
}

const MOOD_DOT = { calm: '#34d399', neutral: '#94a3b8', distressed: '#f87171' }

const MOCK_HUMAN_AGENTS = [
  { id: 'carolina', name: 'Carolina M.', status: 'ON_CONTACT',         contactId: 'mock-diego' },
  { id: 'mariano',  name: 'Mariano F.',  status: 'ON_CONTACT',         contactId: 'mock-elena' },
  { id: 'sofia',    name: 'Sofía R.',    status: 'AFTER_CONTACT_WORK' },
  { id: 'tomas',    name: 'Tomás L.',    status: 'AVAILABLE' },
]

const MOCK_CONTACTS = [
  { id: 'mock-pedro',  customerName: 'Pedro G.',  task: 'Solicitud de tarjeta de crédito',                       state: 'in_queue',   channel: 'VOICE', mood: 'calm',       queueDurationSec: 47, isReal: false },
  { id: 'mock-roxana', customerName: 'Roxana V.', task: 'Consulta saldo de plazo fijo',                          state: 'in_queue',   channel: 'CHAT',  mood: 'neutral',    queueDurationSec: 23, isReal: false },
  { id: 'mock-diego',  customerName: 'Diego A.',  task: 'Reprogramar plazo fijo',                                state: 'consulting', channel: 'VOICE', mood: 'calm',       agentId: 'carolina',  isReal: false },
  { id: 'mock-elena',  customerName: 'Elena S.',  task: 'Pide hablar con un asesor sobre rechazo de préstamo',    state: 'escalated',  channel: 'VOICE', mood: 'distressed', agentId: 'mariano',   isReal: false },
]

const TOOL_TO_STATE = {
  identificar_cliente:         'identifying',
  consultar_perfil_crediticio: 'consulting',
  evaluar_prestamo:            'evaluating',
}

// ─── Capa 1 · Adaptador (espejo de Connect GetCurrentMetricData) ─────────────
function useConnectMetrics() {
  const { toolCalls, conversationState, isRunning } = useAgent()

  const veraStatus = isRunning
    ? 'ON_CONTACT'
    : (conversationState === 'resolved' || conversationState === 'escalated') ? 'AFTER_CONTACT_WORK'
    : 'AVAILABLE'

  const identDone = toolCalls.find((tc) => tc.name === 'identificar_cliente' && tc.status === 'done')
  const customerName = identDone?.result?.nombre ?? 'Esperando identificación'

  const runningName = toolCalls.find((tc) => tc.status === 'running')?.name
  const lastName    = toolCalls[toolCalls.length - 1]?.name

  const realState =
      conversationState === 'escalated' ? 'escalated'
    : conversationState === 'resolved'  ? 'resolved'
    : runningName ? TOOL_TO_STATE[runningName]
    : toolCalls.length === 0 ? 'in_queue'
    : TOOL_TO_STATE[lastName] ?? 'in_queue'

  const realContact = {
    id: 'real-current',
    customerName,
    task: customerName === 'Esperando identificación'
      ? 'Cliente conectado · sin identificar'
      : 'Asistencia con producto financiero',
    state: realState,
    channel: 'VOICE',
    mood: realState === 'escalated' ? 'distressed' : 'calm',
    agentId: 'vera',
    isReal: true,
    queueDurationSec: 0,
  }

  const veraAgent = {
    id: 'vera',
    name: 'Vera',
    status: veraStatus,
    contactId: veraStatus === 'AVAILABLE' ? undefined : 'real-current',
    isBot: true,
  }

  const agents = [veraAgent, ...MOCK_HUMAN_AGENTS]
  const contacts = [realContact, ...MOCK_CONTACTS]

  const inQueueContacts = contacts.filter((c) => c.state === 'in_queue')
  const metricResults = [{
    collections: [
      { metric: { name: 'AGENTS_ONLINE',      unit: 'COUNT' },   value: agents.length },
      { metric: { name: 'AGENTS_AVAILABLE',   unit: 'COUNT' },   value: agents.filter((a) => a.status === 'AVAILABLE').length },
      { metric: { name: 'CONTACTS_IN_QUEUE',  unit: 'COUNT' },   value: inQueueContacts.length },
      { metric: { name: 'OLDEST_CONTACT_AGE', unit: 'SECONDS' }, value: Math.max(0, ...inQueueContacts.map((c) => c.queueDurationSec ?? 0)) },
    ],
    dimensions: { channel: 'VOICE' },
  }]

  return { metricResults, agents, contacts }
}

function getMetric(metricResults, name) {
  for (const r of metricResults) for (const c of r.collections) if (c.metric.name === name) return c.value
  return null
}

function formatAge(sec) {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}m ${s}s`
}

// ─── Primitivos reutilizables ────────────────────────────────────────────────
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

// ─── Capa 2 · UI ─────────────────────────────────────────────────────────────
function MetricBox({ label, value, icon, spark }) {
  return (
    <div className="rounded-2xl p-5 bg-slate-900/50 border border-slate-800/80" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <span className="text-slate-500"><Icon d={icon} /></span>
      </div>
      <p className="text-3xl font-semibold mt-1 text-slate-100">{value}</p>
      {spark && <Sparkline data={spark} color="#5eead4" />}
    </div>
  )
}

function KPIStrip({ metricResults }) {
  const online = getMetric(metricResults, 'AGENTS_ONLINE')
  const queue  = getMetric(metricResults, 'CONTACTS_IN_QUEUE')
  const oldest = getMetric(metricResults, 'OLDEST_CONTACT_AGE')
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <MetricBox label="Agents online"      value={online}            icon="M16 11a4 4 0 1 0-8 0M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" spark={[4,5,5,4,5,5,5,5]} />
      <MetricBox label="Contacts in queue"  value={queue}             icon="M3 6h18M3 12h18M3 18h18"                                       spark={[1,2,2,3,2,2,1,2]} />
      <MetricBox label="Oldest in queue"    value={formatAge(oldest)} icon="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"              spark={[10,20,30,25,35,40,42,47]} />
      <div className="rounded-2xl p-5 bg-emerald-500/[0.07] border border-emerald-500/25 flex items-center gap-4" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}>
        <Ring pct={84} color="#34d399" />
        <div>
          <p className="text-sm text-slate-300">Resolved without human</p>
          <p className="text-xs text-slate-500 mt-1">acumulado del día</p>
        </div>
      </div>
    </div>
  )
}

function Avatar({ name, isBot }) {
  const initials = name.split(' ').map((s) => s[0]).slice(0, 2).join('')
  return (
    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
      isBot ? 'bg-violet-500/20 text-violet-200' : 'bg-slate-700/40 text-slate-300'
    }`}>{initials}</div>
  )
}

function AgentList({ agents, contacts }) {
  const contactById = (id) => contacts.find((c) => c.id === id)
  return (
    <div className="rounded-2xl bg-slate-900/40 border border-slate-800 p-4" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.2)' }}>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-medium text-slate-300">Agents</h2>
        <span className="text-xs text-slate-500">{agents.length} online</span>
      </div>
      <div className="flex flex-col gap-2">
        {agents.map((a) => {
          const s = AGENT_STATUS_STYLE[a.status]
          const contact = a.contactId ? contactById(a.contactId) : null
          return (
            <div key={a.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-slate-900/40 border border-slate-800/60">
              <Avatar name={a.name} isBot={a.isBot} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200 flex items-center gap-2">
                  {a.name}
                  {a.isBot && <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">AI</span>}
                </p>
                {contact && <p className="text-xs text-slate-500 truncate">→ {contact.customerName}</p>}
              </div>
              <span className={`text-[10px] px-2 py-1 rounded-full shrink-0 flex items-center gap-1.5 ${s.pill}`}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }}></span>
                {s.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ChannelIcon({ channel }) {
  const d = channel === 'CHAT'
    ? 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
    : 'M22 16.92v3a2 2 0 0 1-2.18 2 19.86 19.86 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.86 19.86 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'
  return <Icon d={d} className="text-slate-500" />
}

function ContactList({ contacts }) {
  return (
    <div className="rounded-2xl bg-slate-900/40 border border-slate-800 p-4" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.2)' }}>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-medium text-slate-300">Contacts</h2>
        <span className="flex items-center gap-2 text-xs text-slate-500">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>en vivo
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {contacts.map((c) => {
          const s = CONTACT_STATE_STYLE[c.state]
          const isAlert = c.mood === 'distressed'
          const base = isAlert
            ? 'bg-red-500/10 border-2 border-red-500/50 animate-[alertpulse_2s_ease-in-out_infinite]'
            : c.isReal
              ? 'bg-slate-900/40 border border-cyan-500/40'
              : 'bg-slate-900/40 border border-slate-800/60'
          return (
            <div key={c.id} className={`flex items-center gap-3 rounded-xl px-3 py-3 ${base}`}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: MOOD_DOT[c.mood] }}></span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200 flex items-center gap-2">
                  {c.customerName}
                  {c.isReal && <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">live</span>}
                </p>
                <p className={`text-xs truncate ${isAlert ? 'text-red-300/80' : 'text-slate-500'}`}>{c.task}</p>
              </div>
              <ChannelIcon channel={c.channel} />
              <span className={`text-[10px] px-2 py-1 rounded-full shrink-0 ${s.pill}`}>{s.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Capa 3 · Pantalla ───────────────────────────────────────────────────────
export default function AdminScreen({ go, monitorMode }) {
  const { reset } = useAgent()
  const { metricResults, agents, contacts } = useConnectMetrics()

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e15]">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800">
        {!monitorMode && (
          <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        )}
        <span className="text-sm font-mono text-amber-400">04</span>
        <span className="text-lg font-medium">Connect · vera-fsi instance</span>
        <span className="text-xs text-slate-500 font-mono">region us-east-1</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>conectado
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-6xl mx-auto">
          <KPIStrip metricResults={metricResults} />
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-2"><AgentList agents={agents} contacts={contacts} /></div>
            <div className="lg:col-span-3"><ContactList contacts={contacts} /></div>
          </div>
          <div className="flex justify-center mt-8">
            <button onClick={reset} className="text-sm px-5 py-2 rounded-full border border-slate-700 text-slate-400 hover:text-white transition-colors">↺ reiniciar sesión</button>
          </div>
        </div>
      </div>
    </div>
  )
}
