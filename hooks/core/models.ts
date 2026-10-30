/**
 * How much context a model holds.
 *
 * The engine publishes the real window for the session itself, so the main
 * row never guesses. A subagent's loop has no such reading, and the only thing
 * to go on is the model id — so this table names the models known to hold more
 * than the common window, and everything else is assumed to hold the common
 * one and is drawn as an assumption rather than as a fact.
 *
 * Assuming the larger window is the mistake worth avoiding: it reports a
 * subagent at a fifth of its true context fill, which reads as plenty of room
 * right up to the compaction.
 */
const COMMON = 200_000

const LARGE: readonly RegExp[] = [/sonnet-5/, /haiku-5-5/]

export type ContextWindow = {
  tokens: number
  /** False when the window is assumed from the common size, not known. */
  isKnown: boolean
}

export function windowOf(model: string | null): ContextWindow {
  if (model === null || model === '') return { tokens: COMMON, isKnown: false }
  const id = model.toLowerCase()
  if (LARGE.some(re => re.test(id))) return { tokens: 1_000_000, isKnown: true }
  if (/opus|haiku-4|claude-3/.test(id)) return { tokens: COMMON, isKnown: true }
  return { tokens: COMMON, isKnown: false }
}

/** Short enough for a row: `opus · high`, `sonnet-5-5`. */
export function shortModel(model: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)[-\d.]*/.exec(model.toLowerCase())
  return m?.[0]?.replace(/-$/, '') ?? model
}
