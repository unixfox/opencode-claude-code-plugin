/**
 * Per-session state for the opt-in `compress` proxy tool.
 *
 * Keyed by session key (the same `cwd::modelId::scope::affinity` string
 * session-manager uses). When Claude calls the intercepted `compress` tool
 * the summary is stored here and the session is marked for restart. The
 * next `doStream` turn consumes that mark, evicts the running child and its
 * Claude session id, and the fresh spawn gets the summary prepended to its
 * appended system prompt.
 *
 * The summary deliberately survives `deleteClaudeSessionId()`: the restart
 * path calls it, so clearing there would wipe the summary microseconds
 * before the new spawn reads it (the original fork version did exactly
 * that, which made the whole feature a no-op). It is dropped when a new
 * opencode conversation starts on the same key, and by the entry cap below.
 */

import { log } from "./logger.js"

interface CompressionState {
  summary: string
  restartPending: boolean
}

/**
 * Session keys are bounded in practice by workspaces × models, and each
 * entry is one summary string, but a long-lived opencode process that
 * hops workspaces should not accumulate them forever.
 */
const MAX_COMPRESSION_ENTRIES = 32

const compressions = new Map<string, CompressionState>()

/**
 * Record a summary and mark the session for restart. Storing and marking
 * are one event on purpose: a stored summary that never resets the session
 * would silently do nothing.
 */
export function storeCompressionSummary(sessionKey: string, summary: string): void {
  compressions.set(sessionKey, { summary, restartPending: true })
  while (compressions.size > MAX_COMPRESSION_ENTRIES) {
    const oldest = compressions.keys().next()
    if (oldest.done) break
    compressions.delete(oldest.value)
    log.info("compression store evicted oldest entry", { sessionKey: oldest.value })
  }
}

export function getCompressionSummary(sessionKey: string): string | undefined {
  return compressions.get(sessionKey)?.summary
}

/**
 * True once per compress call, for the turn that performs the reset. The
 * summary is kept: it is the prior context for every spawn that follows,
 * until a new conversation clears it.
 */
export function consumeCompressionRestart(sessionKey: string): boolean {
  const state = compressions.get(sessionKey)
  if (!state?.restartPending) return false
  state.restartPending = false
  return true
}

export function clearCompression(sessionKey: string): void {
  compressions.delete(sessionKey)
}
