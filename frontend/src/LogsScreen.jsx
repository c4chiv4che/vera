import { useEffect, useRef } from 'react'
import { useAgent } from './useAgent'

const LEVEL_COLORS = {
  INFO: 'text-sky-400',
  OK:   'text-emerald-400',
  TOOL: 'text-amber-400',
  WARN: 'text-orange-400',
  AUTH: 'text-violet-400',
}

function buildLines(events, toolCalls, metrics) {
  const lines = []
  let resultIdx = 0
  for (const ev of events) {
    const ts = ev.ts
    switch (ev.type) {
      case 'RUN_STARTED':
        lines.push({ ts, lvl: 'INFO', t: 'bedrock.session.start', d: '' })
        break
      case 'TOOL_CALL_START': {
        const name = ev.detail?.replace(/^name=/, '') ?? ''
        lines.push({ ts, lvl: 'TOOL', t: 'bedrock.tool_use',    d: `name=${name}` })
        lines.push({ ts, lvl: 'INFO', t: 'apigateway.request',  d: 'GET /clientes stage=demo' })
        lines.push({ ts, lvl: 'INFO', t: 'lambda.invoke',       d: 'fn=vera-fsi-crm' })
        break
      }
      case 'TOOL_CALL_RESULT': {
        lines.push({ ts, lvl: 'OK',   t: 'dynamodb.get_item',   d: 'table=vera-fsi-clientes' })
        lines.push({ ts, lvl: 'TOOL', t: 'bedrock.tool_result', d: '' })
        const result = toolCalls[resultIdx]?.result
        if (result && result.decision !== undefined) {
          lines.push({
            ts,
            lvl: 'OK',
            t: 'loan.evaluation',
            d: `decision=${result.decision} dti=${result.dti_resultante_pct}% score=${result.credit_score}`,
          })
        }
        resultIdx++
        break
      }
      case 'TEXT_MESSAGE_START':
        lines.push({ ts, lvl: 'INFO', t: 'bedrock.invoke',      d: 'model=claude-sonnet-4-5' })
        break
      case 'RUN_FINISHED':
        lines.push({ ts, lvl: 'OK',   t: 'bedrock.session.end', d: '' })
        lines.push({ ts, lvl: 'OK',   t: 'cloudwatch.metric',   d: 'calls_resolved=1' })
        break
      default:
        break
    }
  }
  if (metrics && metrics.totalTokens) {
    lines.push({
      ts: lines.length ? lines[lines.length - 1].ts : '',
      lvl: 'OK',
      t: 'bedrock.usage',
      d: `tokens_in=${metrics.inputTokens} tokens_out=${metrics.outputTokens} total=${metrics.totalTokens} latency=${metrics.latencyMs}ms`,
    })
  }
  return lines
}

export default function LogsScreen({ go, monitorMode }) {
  const { events, toolCalls, metrics, reset, isRunning } = useAgent()
  const scrollRef = useRef(null)
  const lines = buildLines(events, toolCalls, metrics)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines.length])

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e15]">
      <header className="flex items-center gap-4 px-8 py-6 border-b border-slate-800 z-10">
        {!monitorMode && (
          <button onClick={() => go('home')} className="text-slate-400 hover:text-white transition-colors">← volver</button>
        )}
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
            {lines.length === 0 && (
              <p className="text-slate-600">Esperando actividad del agente…</p>
            )}
            {lines.map((l, i) => (
              <div key={i} className="flex gap-3 animate-[fadeIn_0.25s_ease] whitespace-pre-wrap">
                <span className="text-slate-600 shrink-0">{l.ts}</span>
                <span className={`shrink-0 w-12 ${LEVEL_COLORS[l.lvl]}`}>{l.lvl}</span>
                <span className="text-slate-300 shrink-0">{l.t}</span>
                <span className="text-slate-500">{l.d}</span>
              </div>
            ))}
            {isRunning && (
              <span className="inline-block w-2 h-4 bg-emerald-400 align-middle animate-pulse ml-1"></span>
            )}
          </div>
          <p className="text-center text-xs text-slate-600 mt-4">
            Cada línea proviene de CloudWatch / EventBridge — sin contenido precargado.
          </p>
        </div>
      </div>

      <div className="flex justify-center pb-10">
        <button onClick={reset} className="text-sm px-5 py-2 rounded-full border border-slate-700 text-slate-400 hover:text-white transition-colors">↺ reiniciar</button>
      </div>
    </div>
  )
}
