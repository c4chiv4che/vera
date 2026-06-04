import { useState, useEffect, useRef } from 'react'
import VoiceOrb from './VoiceOrb'
import FlowScreen from './FlowScreen'
import LogsScreen from './LogsScreen'
import AdminScreen from './AdminScreen'
import { useAgent } from './AgentContext'
import { useVoiceSession } from './useVoiceSession'

const SCREENS = [
  { id: 'patient', n: '01', title: 'Vista del cliente', desc: 'La conversación con voz, en vivo', color: 'text-cyan-400' },
  { id: 'flow', n: '02', title: 'Orquestación', desc: 'Qué servicios se activan ahora', color: 'text-violet-400' },
  { id: 'logs', n: '03', title: 'Logs técnicos', desc: 'El sistema por dentro, sin trucos', color: 'text-emerald-400' },
  { id: 'admin', n: '04', title: 'Panel de control', desc: 'Clientes, estado y ánimo', color: 'text-amber-400' },
]

const STATE_LABELS = { listen: 'escuchando…', think: 'pensando…', speak: 'hablando…' }

function Home({ go }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6">
      <p className="text-sm tracking-[0.3em] text-slate-500 uppercase mb-4">Banco · asistente con voz</p>
      <h1 className="text-7xl font-semibold tracking-tight mb-3">Vera</h1>
      <p className="text-lg text-slate-400 mb-16 text-center max-w-md">
        Tu recepción, ahora con voz. Consultá, pedí y resolvé hablando.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-3xl">
        {SCREENS.map((s) => (
          <button
            key={s.id}
            onClick={() => go(s.id)}
            className="group text-left p-6 rounded-2xl border border-slate-800 hover:border-slate-600 bg-slate-900/40 hover:bg-slate-900/80 transition-all duration-300"
          >
            <div className="flex items-baseline gap-3 mb-2">
              <span className={`text-sm font-mono ${s.color}`}>{s.n}</span>
              <span className="text-xl font-medium">{s.title}</span>
            </div>
            <p className="text-sm text-slate-500">{s.desc}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function Bubble({ who, children, opacity = 1 }) {
  return (
    <div className={`flex ${who === 'user' ? 'justify-end' : 'justify-start'}`} style={{ opacity, transition: 'opacity 0.6s ease' }}>
      <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-[15px] leading-relaxed animate-[fadeIn_0.4s_ease] ${
        who === 'user' ? 'bg-cyan-500/15 text-cyan-100 rounded-br-sm' : 'bg-slate-800/70 text-slate-200 rounded-bl-sm'
      }`}>
        <span className={`block text-[10px] uppercase tracking-wider mb-1 ${who === 'user' ? 'text-cyan-400/60' : 'text-violet-400/60'}`}>
          {who === 'user' ? 'Cliente' : 'Vera'}
        </span>
        {children}
      </div>
    </div>
  )
}

// Voice status labels — shown under the orb while we wait or while Vera is silent
const VOICE_LABELS = {
  'requesting-mic': 'pidiendo acceso al micrófono…',
  'connecting': 'conectando con Vera…',
  'active': 'hablá cuando quieras',
  'ended': 'llamada finalizada',
  'error': 'no pude acceder al micrófono',
}

function PatientScreen({ go }) {
  const { messages, veraStatus, sendMessage, reset } = useAgent()
  const [started, setStarted] = useState(false)
  const { state: voiceState, error: voiceError, end: endVoice } = useVoiceSession({
    url: 'ws://localhost:8081/ws',
    autoStart: started,
  })

  const [textFallback, setTextFallback] = useState(false)
  const [input, setInput] = useState('')
  const scrollRef = useRef(null)

  // Orb mood: prefer veraStatus while there's an active conversation;
  // fall back to listen state otherwise.
  const mode = veraStatus === 'thinking' ? 'think' : veraStatus === 'speaking' ? 'speak' : 'listen'
  const active = messages.length > 0

  // Bottom label under "Vera · Voice-Enabled Receptionist Assistant"
  const callIsLive = voiceState === 'active'
  const statusLine = callIsLive ? STATE_LABELS[mode] : (VOICE_LABELS[voiceState] || '')

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  function submitText() {
    const text = input.trim()
    if (!text) return
    sendMessage(text)
    setInput('')
  }

  function handleEndCall() {
    endVoice()
    // Note: we intentionally do NOT call reset() here. The conversation
    // history should remain visible after the call ends so the user can
    // see what happened. A future "new call" button would reset.
  }

  return (
    <div className="relative h-screen overflow-hidden flex flex-col">
      <button onClick={() => go('home')} className="absolute top-6 left-8 z-20 text-slate-400 hover:text-white transition-colors">← volver</button>

      {/* Tap-to-start overlay. Browsers require a user gesture before AudioContext
          and MediaStream tracks start producing real samples. Tapping anywhere
          on the screen counts; we don't dictate where. */}
      {!started && (
        <button
          onClick={() => setStarted(true)}
          className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#0b1018]/80 backdrop-blur-sm cursor-pointer transition-opacity hover:bg-[#0b1018]/70"
        >
          <p className="text-3xl font-light text-slate-200">Tocá para hablar con Vera</p>
          <p className="text-xs tracking-[0.3em] text-slate-500 uppercase mt-4">poné los auriculares antes</p>
        </button>
      )}

      <div className="relative h-[50vh] shrink-0">
        <div className="absolute inset-0"><VoiceOrb mode={mode} /></div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 text-center pointer-events-none">
          <div className="absolute inset-0 -m-16 bg-[#0b1018] blur-2xl opacity-70 rounded-full"></div>
          <div className="relative">
            <h1 className="text-5xl font-semibold tracking-tight">Vera</h1>
            <p className="text-xs tracking-[0.35em] text-slate-400 uppercase mt-3">Voice-Enabled Receptionist Assistant</p>
            {statusLine && <p className="text-slate-500 text-sm mt-6">{statusLine}</p>}
            {voiceState === 'error' && voiceError && (
              <p className="text-rose-400/70 text-xs mt-2 max-w-xs mx-auto">{voiceError}</p>
            )}
          </div>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} className="h-full overflow-y-auto px-6 pb-32 pt-8"
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 22%, black 100%)', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 22%, black 100%)' }}>
          <div className="max-w-2xl mx-auto flex flex-col gap-3">
            {!active && voiceState === 'active' && (
              <p className="text-center text-slate-600 text-sm pt-8">Decile a Vera por qué llamás…</p>
            )}
            {messages.map((m, i) => {
              const fromEnd = messages.length - 1 - i
              const opacity = fromEnd === 0 ? 1 : fromEnd === 1 ? 0.55 : fromEnd === 2 ? 0.3 : 0.15
              const who = m.role === 'assistant' ? 'vera' : 'user'
              return <Bubble key={m.id} who={who} opacity={opacity}>{m.content}</Bubble>
            })}
          </div>
        </div>
      </div>

      {/* Bottom bar: voice controls + discrete text fallback toggle */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-3 w-full max-w-2xl px-6">

        {textFallback && (
          <div className="flex items-center gap-2 w-full">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitText() }}
              placeholder="Escribí tu mensaje…"
              className="flex-1 text-[15px] px-4 py-2.5 rounded-full border border-slate-700 bg-slate-800/60 text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-500 transition-colors"
            />
            <button onClick={submitText}
              className="shrink-0 text-sm px-5 py-2.5 rounded-full border border-slate-600 text-white bg-slate-800/60 hover:bg-slate-700/60 transition-colors">
              enviar
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          {(voiceState === 'active' || voiceState === 'connecting' || voiceState === 'requesting-mic') && (
            <button onClick={handleEndCall}
              className="text-sm px-5 py-2.5 rounded-full border border-rose-500/40 text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 transition-colors">
              ■ terminar llamada
            </button>
          )}
          {voiceState === 'ended' || voiceState === 'error' ? (
            <button onClick={reset}
              className="text-xs px-3 py-2.5 rounded-full border border-slate-700 text-slate-400 hover:text-white transition-colors">
              ↺ limpiar conversación
            </button>
          ) : null}
          <button onClick={() => setTextFallback((v) => !v)}
            className="text-xs px-3 py-2.5 rounded-full border border-slate-800 text-slate-500 hover:text-slate-300 transition-colors">
            {textFallback ? 'voz' : '⌨ usar texto'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Screen({ id, go }) {
  const s = SCREENS.find((x) => x.id === id)
  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800">
        <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        <span className={`text-sm font-mono ${s.color}`}>{s.n}</span>
        <span className="text-lg font-medium">{s.title}</span>
      </header>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-slate-600">contenido de «{s.title}» — próximamente</p>
      </div>
    </div>
  )
}

// Map ?view= URL param to a dedicated full-screen view (monitor mode)
const VIEW_COMPONENTS = {
  user: PatientScreen,
  flow: FlowScreen,
  logs: LogsScreen,
  admin: AdminScreen,
}

function App() {
  const params = new URLSearchParams(window.location.search)
  const view = params.get('view')

  // useState must be called unconditionally on every render to satisfy
  // React's rules-of-hooks. Even when we end up returning a monitor view
  // (where `screen` is unused), the hook itself has to be invoked.
  const [screen, setScreen] = useState('home')

  // Monitor mode: a single view, full-screen, no home navigation
  if (view && VIEW_COMPONENTS[view]) {
    const ViewComponent = VIEW_COMPONENTS[view]
    return <ViewComponent go={() => {}} monitorMode />
  }

  // Default: navigable home
  if (screen === 'home') return <Home go={setScreen} />
  if (screen === 'patient') return <PatientScreen go={setScreen} />
  if (screen === 'flow') return <FlowScreen go={setScreen} />
  if (screen === 'logs') return <LogsScreen go={setScreen} />
  if (screen === 'admin') return <AdminScreen go={setScreen} />
  return <Screen id={screen} go={setScreen} />
}

export default App
