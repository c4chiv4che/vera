import { useState, useEffect, useRef } from 'react'

const LEVEL_COLORS = {
  INFO: 'text-sky-400',
  OK:   'text-emerald-400',
  TOOL: 'text-amber-400',
  WARN: 'text-orange-400',
  AUTH: 'text-violet-400',
}

const LOGS = [
  { lvl: 'INFO', t: 'connect.contact.started', d: 'id=a3f9c1 channel=VOICE locale=es-AR' },
  { lvl: 'INFO', t: 'connect.queue.matched', d: 'queue=vera-inbound agent=BOT waitTime=0s' },
  { lvl: 'OK',   t: 'lambda.warmpool', d: 'fn=vera-orchestrator warm=3/3 status=ready' },
  { lvl: 'INFO', t: 'transcribe.stream.open', d: 'engine=amazon-transcribe sampleRate=8000 lang=es-AR' },
  { lvl: 'OK',   t: 'polly.synthesize', d: 'voice=Mía text="Hola, soy Vera" audioMs=210' },
  { lvl: 'INFO', t: 'transcribe.partial', d: '"hola buenas..." stability=0.61' },
  { lvl: 'INFO', t: 'transcribe.partial', d: '"hola buenas quería..." stability=0.84' },
  { lvl: 'AUTH', t: 'voiceid.evaluate', d: 'result=NOT_ENROLLED score=n/a fallback=otp' },
  { lvl: 'INFO', t: 'otp.generate', d: 'code=•••• ttl=300s' },
  { lvl: 'OK',   t: 'sns.publish', d: 'channel=SMS to=+54•••••4417 messageId=8a1f latency=240ms' },
  { lvl: 'INFO', t: 'otp.sent', d: 'channel=SMS to=+54•••••4417 ttl=300s' },
  { lvl: 'INFO', t: 'transcribe.partial', d: '"el código es nueve dos..." stability=0.79' },
  { lvl: 'OK',   t: 'otp.verified', d: 'patient_id=MR-2291 attempts=1' },
  { lvl: 'OK',   t: 'dynamodb.query', d: 'table=Patients key=MR-2291 items=1 latency=9ms' },
  { lvl: 'OK',   t: 'identity.resolved', d: 'patient="Martín R." patient_id=MR-2291 method=otp' },
  { lvl: 'OK',   t: 'session.state.write', d: 'session=a3f9c1 stage=AUTHENTICATED latency=7ms' },
  { lvl: 'INFO', t: 'transcribe.partial', d: '"quería sacar un turno..." stability=0.72' },
  { lvl: 'INFO', t: 'transcribe.final', d: '"quería sacar un turno con el doctor Ramírez"' },
  { lvl: 'INFO', t: 'bedrock.invoke', d: 'model=claude intent=book_appointment conf=0.94' },
  { lvl: 'TOOL', t: 'bedrock.tool_use', d: 'name=get_availability args={doctor:"Ramírez",window:"7d"}' },
  { lvl: 'INFO', t: 'lambda.invoke', d: 'fn=get_availability coldStart=true initMs=820' },
  { lvl: 'OK',   t: 'dynamodb.dax', d: 'cache=hit key=doctor:Ramírez:profile latency=2ms' },
  { lvl: 'OK',   t: 'dynamodb.query', d: 'table=Appointments index=byDoctor items=0 (semana actual) latency=14ms' },
  { lvl: 'OK',   t: 'dynamodb.query', d: 'table=Appointments index=byDoctor items=2 (semana siguiente) latency=11ms' },
  { lvl: 'OK',   t: 'lambda.result', d: 'fn=get_availability durationMs=86 billedMs=900' },
  { lvl: 'TOOL', t: 'bedrock.tool_result', d: 'slots=["mar 3 10:30","jue 5 16:00"] alt_doctor="Sosa"' },
  { lvl: 'OK',   t: 'bedrock.response', d: 'tokens_in=512 tokens_out=96 latency=1.2s' },
  { lvl: 'OK',   t: 'polly.synthesize', d: 'voice=Mía text="Tengo el jueves a las 16" audioMs=340' },
  { lvl: 'INFO', t: 'cloudwatch.heartbeat', d: 'stream=vera-live-stream lag=0ms healthy=true' },
  { lvl: 'INFO', t: 'transcribe.partial', d: '"el jueves a las cuatro..." stability=0.77' },
  { lvl: 'INFO', t: 'transcribe.final', d: '"dale, el jueves a las cuatro está perfecto"' },
  { lvl: 'INFO', t: 'bedrock.invoke', d: 'model=claude intent=confirm_slot slot="jue 5 16:00" conf=0.97' },
  { lvl: 'TOOL', t: 'bedrock.tool_use', d: 'name=book_appointment args={doctor:"Ramírez",slot:"jue 5 16:00",patient:"MR-2291"}' },
  { lvl: 'INFO', t: 'lambda.invoke', d: 'fn=book_appointment coldStart=false' },
  { lvl: 'OK',   t: 'dynamodb.put_item', d: 'table=Appointments id=APT-7741 condition=ok latency=18ms' },
  { lvl: 'TOOL', t: 'bedrock.tool_result', d: 'booked=true appointment_id=APT-7741' },
  { lvl: 'OK',   t: 'appointment.booked', d: 'doctor="Ramírez" slot="jue 5 16:00" id=APT-7741' },
  { lvl: 'INFO', t: 'eventbridge.put_events', d: 'bus=vera-events detail-type=AppointmentBooked id=APT-7741' },
  { lvl: 'OK',   t: 'lambda.invoke', d: 'fn=notify-confirm channel=WHATSAPP coldStart=false' },
  { lvl: 'OK',   t: 'whatsapp.sent', d: 'to=+54•••••4417 template=appt_confirm status=DELIVERED' },
  { lvl: 'OK',   t: 'session.state.write', d: 'session=a3f9c1 stage=BOOKED appt=APT-7741' },
  { lvl: 'INFO', t: 'bedrock.proactive_check', d: 'scanning patient_history pending_actions' },
  { lvl: 'TOOL', t: 'bedrock.tool_use', d: 'name=get_pending_referrals patient_id=MR-2291' },
  { lvl: 'INFO', t: 'lambda.invoke', d: 'fn=get_pending_referrals coldStart=false' },
  { lvl: 'OK',   t: 'dynamodb.query', d: 'table=LabResults index=byPatient items=1 latency=12ms' },
  { lvl: 'TOOL', t: 'bedrock.tool_result', d: 'referral={specialty:"cardiología",date:"2026-03"} status=NOT_SCHEDULED' },
  { lvl: 'WARN', t: 'referral.pending', d: 'specialty=cardiología age=68d status=NOT_SCHEDULED suggest_doctor="Funes"' },
  { lvl: 'INFO', t: 'sentiment.score', d: 'value=+0.21 label=neutral via=bedrock' },
  { lvl: 'INFO', t: 'bedrock.invoke', d: 'model=claude intent=suggest_referral conf=0.90' },
  { lvl: 'OK',   t: 'bedrock.response', d: 'action=suggest_referral tokens_in=388 tokens_out=74 latency=0.8s' },
  { lvl: 'OK',   t: 'polly.synthesize', d: 'voice=Mía text="También conviene ver a cardiología con Funes" audioMs=410' },
  { lvl: 'OK',   t: 'session.state.write', d: 'session=a3f9c1 stage=RESOLVED handoff=false' },
  { lvl: 'OK',   t: 'cloudwatch.metric', d: 'namespace=Vera calls_resolved_bot=1 handoff=0' },
  { lvl: 'OK',   t: 'connect.contact.resolved', d: 'duration=132s human_handoff=false' },
]

let clock = new Date()
clock.setHours(10, 42, 1, 220)
function stamp(i) {
  const d = new Date(clock.getTime() + i * 437 + (i % 3) * 120)
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export default function LogsScreen({ go }) {
  const [count, setCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const scrollRef = useRef(null)
  const timer = useRef(null)

  useEffect(() => {
    if (!playing) return
    if (count >= LOGS.length) { setPlaying(false); return }
    timer.current = setTimeout(() => setCount((c) => c + 1), count === 0 ? 300 : 480 + (count % 4) * 130)
    return () => clearTimeout(timer.current)
  }, [playing, count])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [count])

  function start() { setCount(0); setPlaying(true) }
  function reset() { clearTimeout(timer.current); setPlaying(false); setCount(0) }

  const visible = LOGS.slice(0, count)

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e15]">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800 z-10">
        <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        <span className="text-sm font-mono text-emerald-400">03</span>
        <span className="text-lg font-medium">Logs técnicos</span>
        <span className="ml-auto text-sm text-slate-500 font-mono">session a3f9c1 · region us-east-1</span>
      </header>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-4xl">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-t-xl bg-slate-900 border border-slate-800 border-b-0">
            <span className="w-3 h-3 rounded-full bg-red-500/70"></span>
            <span className="w-3 h-3 rounded-full bg-amber-500/70"></span>
            <span className="w-3 h-3 rounded-full bg-emerald-500/70"></span>
            <span className="ml-3 text-xs text-slate-500 font-mono">cloudwatch · vera-live-stream</span>
          </div>
          <div ref={scrollRef} className="h-[60vh] overflow-y-auto rounded-b-xl bg-[#0b0f17] border border-slate-800 p-5 font-mono text-[13px] leading-[1.9]">
            {visible.length === 0 && (
              <p className="text-slate-600">Esperando eventos… tocá «iniciar stream».</p>
            )}
            {visible.map((l, i) => (
              <div key={i} className="flex gap-3 animate-[fadeIn_0.25s_ease] whitespace-pre-wrap">
                <span className="text-slate-600 shrink-0">{stamp(i)}</span>
                <span className={`shrink-0 w-12 ${LEVEL_COLORS[l.lvl]}`}>{l.lvl}</span>
                <span className="text-slate-300 shrink-0">{l.t}</span>
                <span className="text-slate-500">{l.d}</span>
              </div>
            ))}
            {playing && count < LOGS.length && (
              <span className="inline-block w-2 h-4 bg-emerald-400 align-middle animate-pulse ml-1"></span>
            )}
          </div>
          <p className="text-center text-xs text-slate-600 mt-4">
            Cada línea proviene de CloudWatch / EventBridge — sin contenido precargado.
          </p>
        </div>
      </div>

      <div className="flex justify-center pb-10">
        {!playing && count === 0 && (
          <button onClick={start} className="text-sm px-5 py-2 rounded-full border border-emerald-500/50 text-emerald-100 bg-emerald-500/15 hover:bg-emerald-500/25 transition-colors">▶ iniciar stream</button>
        )}
        {(playing || count > 0) && (
          <button onClick={reset} className="text-sm px-5 py-2 rounded-full border border-slate-700 text-slate-400 hover:text-white transition-colors">↺ reiniciar</button>
        )}
      </div>
    </div>
  )
}
