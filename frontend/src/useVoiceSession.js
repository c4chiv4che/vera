// useVoiceSession.js
//
// Custom hook that owns the audio path for a voice conversation with
// Vera: getUserMedia, AudioContext, ScriptProcessorNode for capture,
// queued buffer playback for output, and the WebSocket to the bidi
// server. State of the conversation (messages, vera's mood, tool calls,
// metrics) is NOT in here — that lives in AgentContext, which listens
// to the BFF broadcast independently.
//
// Lifecycle:
//   const { state, error, end } = useVoiceSession({ url: 'ws://localhost:8081/ws' })
//
// state goes through: 'requesting-mic' → 'connecting' → 'active' → 'ended' | 'error'
//
// Audio decisions (ported verbatim from the bidi standalone HTML):
//   - capture: 16 kHz mono, ScriptProcessorNode buffer 4096 samples (~256 ms)
//   - playback: Nova Sonic outputs PCM16 @ 24 kHz; play on the same AudioContext
//   - playbackTime accumulator so consecutive buffers play seamlessly
//   - Float32 ↔ Int16 with asymmetric scaling (-0x8000 / +0x7fff), little-endian
//
// Known caveat: there is no special handling for `type: "interrupt"` events
// from the bidi server. If Vera is mid-sentence and the user barges in, the
// already-queued audio buffers will keep playing. Same behaviour as the
// pelado HTML. Listed in B2.4 cleanup.

import { useEffect, useRef, useState, useCallback } from 'react'

function floatTo16BitPCM(float32) {
  const buf = new ArrayBuffer(float32.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 0x8000
  return out
}

function decodePcm16Base64(b64) {
  const raw = atob(b64)
  const int16 = new Int16Array(raw.length / 2)
  for (let i = 0; i < int16.length; i++) {
    int16[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8)
    if (int16[i] >= 0x8000) int16[i] -= 0x10000
  }
  return int16
}

export function useVoiceSession({ url, autoStart = false } = {}) {
  // 'idle' is the pre-mount state; we move to 'requesting-mic' immediately on mount when autoStart.
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)

  // All audio plumbing lives in refs so the effect can clean it up on unmount
  // without depending on React state updates.
  const wsRef = useRef(null)
  const audioCtxRef = useRef(null)
  const micStreamRef = useRef(null)
  const sourceRef = useRef(null)
  const processorRef = useRef(null)
  const playbackTimeRef = useRef(0)
  const endedRef = useRef(false)

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      try { processorRef.current.disconnect() } catch { /* already disconnected, no-op */ }
      processorRef.current = null
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect() } catch { /* already disconnected, no-op */ }
      sourceRef.current = null
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
    }
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'end' }))
        }
        wsRef.current.close()
      } catch { /* already closing, no-op */ }
      wsRef.current = null
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch { /* already closed, no-op */ }
      audioCtxRef.current = null
    }
  }, [])

  const end = useCallback(() => {
    if (endedRef.current) return
    endedRef.current = true
    cleanup()
    setState('ended')
  }, [cleanup])

  useEffect(() => {
    if (!autoStart) return
    // StrictMode in dev mounts → cleanup → mounts again. We must:
    //   1. Track cancellation in a way that survives an in-flight getUserMedia
    //   2. Store every resource in a ref *as soon as it exists*, so cleanup
    //      can free it even mid-init.
    //   3. Treat WebSocket in CONNECTING state as a valid close target.
    let cancelled = false
    // Reset endedRef on (re)mount; otherwise the second StrictMode mount sees
    // it as already-ended from the first mount's cleanup.
    endedRef.current = false

    async function run() {
      setState('requesting-mic')
      let micStream
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 16000,
            channelCount: 1,
          },
        })
      } catch (e) {
        if (cancelled) return
        setError(e.message || 'microphone permission denied')
        setState('error')
        return
      }
      // Store stream immediately so cleanup can stop tracks if we abort.
      micStreamRef.current = micStream
      if (cancelled) {
        micStream.getTracks().forEach((t) => t.stop())
        return
      }

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
      audioCtxRef.current = audioCtx
      playbackTimeRef.current = audioCtx.currentTime
      if (cancelled) {
        return
      }

      setState('connecting')
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (cancelled || endedRef.current) {
          ws.close()
          return
        }
        setState('active')

        const source = audioCtx.createMediaStreamSource(micStream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        sourceRef.current = source
        processorRef.current = processor
        source.connect(processor)
        processor.connect(audioCtx.destination)

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          const float32 = e.inputBuffer.getChannelData(0)
          const pcm16 = floatTo16BitPCM(float32)
          const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm16)))
          ws.send(JSON.stringify({ type: 'audio', data: b64 }))
        }
      }

      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }

        if (msg.type === 'audio') {
          const int16 = decodePcm16Base64(msg.data)
          const float32 = int16ToFloat32(int16)
          const buf = audioCtx.createBuffer(1, float32.length, 24000)
          buf.getChannelData(0).set(float32)
          const src = audioCtx.createBufferSource()
          src.buffer = buf
          src.connect(audioCtx.destination)
          const t = Math.max(audioCtx.currentTime, playbackTimeRef.current)
          src.start(t)
          playbackTimeRef.current = t + buf.duration
        }
      }

      ws.onerror = () => {
        if (cancelled || endedRef.current) return
        setError('websocket error')
        setState('error')
      }

        ws.onclose = () => {
        if (endedRef.current) return
        // If we were still in CONNECTING when something closed us (e.g.
        // StrictMode unmount), don't bubble that up as a final 'ended'
        // state — the user-facing mount will re-init.
        if (cancelled) return
        endedRef.current = true
        cleanup()
        setState('ended')
      }
    }

    run()

    return () => {
      cancelled = true
      // Don't set endedRef here. Let the next mount reset it.
      cleanup()
    }
  }, [url, autoStart, cleanup])

  return { state, error, end }
}
