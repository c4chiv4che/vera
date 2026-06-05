// Pure helper for AgentContext: reconciles an incoming USER_MESSAGE
// broadcast against the local-echo bookkeeping so the user sees their
// text immediately on click without a duplicate when the BFF's
// rebroadcast arrives a moment later.
//
// Lives in its own file so the dedup logic can be unit-tested
// against synthetic inputs without React in scope.
//
// Strategy: a FIFO queue of pending echoes keyed by content + ts.
// On each incoming USER_MESSAGE we look at the *head* of the queue —
// not arbitrary matching anywhere in the array — to preserve order.
// If the head's content matches the incoming message, we shift the
// queue AND replace exactly ONE _pending message in the messages
// array (the first match by content). Subsequent identical pendings
// stay pending and are reconciled by their own future broadcasts.

const STALE_MS = 10_000

export function reconcileEcho({
  messages,
  pendingEchoes,
  incoming,
  now = Date.now(),
}) {
  // Drop pending echoes older than STALE_MS first — protects against
  // the BFF dying mid-/chat (broadcast never arrives, queue stays full).
  const fresh = pendingEchoes.filter((e) => now - e.ts < STALE_MS)
  const head = fresh[0]

  if (head && head.content === incoming.content) {
    // First-match replacement: scan once, swap only the earliest
    // _pending entry with matching content. Identical pendings that
    // come after stay _pending and wait for their own broadcast.
    let replaced = false
    const newMessages = messages.map((m) => {
      if (!replaced && m._pending && m.content === incoming.content) {
        replaced = true
        return { id: incoming.id, role: "user", content: incoming.content }
      }
      return m
    })
    if (replaced) {
      return { messages: newMessages, pendingEchoes: fresh.slice(1) }
    }
    // Head matched but no _pending found in messages — queue/messages
    // inconsistency (e.g. the echo was cleared by RESET while a stale
    // broadcast was in flight). Fall through to the append branch.
  }

  return {
    messages: [
      ...messages,
      { id: incoming.id, role: "user", content: incoming.content },
    ],
    pendingEchoes: fresh,
  }
}
