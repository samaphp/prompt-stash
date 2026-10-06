export type Thought = {
  id: string
  text: string
  /** Milliseconds since the epoch, when the thought was shelved. */
  caughtAt: number
  sessionId: string
  cwd: string
  /**
   * Decided 2026-10-06: every thought is shelved per session for now, where a
   * session is the conversation (it keeps its shelf when Claude Code continues
   * it under a new session id). Kept on each record so a later upgrade can let
   * the person pick session, project or general at shelving time without
   * rewriting stored thoughts.
   */
  scope: 'session'
  /**
   * A released or deleted thought leaves the shelf and stays in the saved
   * list, hidden, so usage stats can be computed from it later and a deleted
   * one can be brought back.
   */
  status: 'held' | 'released' | 'discarded'
  releasedAt: number | null
  releasedVia: 'fill' | null
  /** When the person deleted it; absent on a thought that is not deleted. */
  discardedAt?: number
}

/**
 * What the prompt box holds, as far as the band cares: an ordinary draft, a
 * `/` or `@` picker being used, the capture marker alone (Enter opens the
 * list), or the marker with a thought after it (Enter shelves that one).
 */
export type DraftKind = 'plain' | 'picker' | 'marker' | 'thought'

declare module 'claude-code' {
  interface PluginState {
    'prompt-stash': {
      thoughts: Thought[]
      /** The session id `thoughts` was loaded under; a change of it triggers a reload. */
      sessionId: string | null
      /** The store key of the conversation whose shelf `thoughts` holds; null before the first load. */
      shelfKey: string | null
      draft: DraftKind
      /** The thought under the highlight in the list: what copy and delete act on. */
      picked: string | null
      /** The thought whose "delete?" question is showing, and when it was asked. */
      asking: { id: string; at: number } | null
      /** The thought deleted last while the list was open: what undo brings back. */
      lastDiscarded: string | null
    }
  }
}
