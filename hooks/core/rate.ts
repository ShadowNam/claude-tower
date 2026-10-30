import type { EngineInterface } from 'claude-code'

import { writeShape } from './state'

import type { Shape } from '../../types'

/**
 * How fast the model is answering, and whether that is unusually slow.
 *
 * When a session drags there is no way to tell whether it is the API, the
 * repository or the prompt, and the three want completely different responses.
 * This answers the first one, and only that one.
 *
 * The hard part is not measuring, it is not crying wolf. A short turn's rate
 * is mostly latency — a two-token answer that took a second reads as 2 tok/s
 * and means nothing — so short turns are not sampled at all. And "slow" has to
 * be slow *for this session*: rates differ by model, by effort and by how much
 * context is being re-sent, so the comparison is against this session's own
 * median rather than any number written down here.
 */

/** Below this many output tokens, a turn's rate is latency, not throughput. */
const MIN_TOKENS = 120
/** Below this long, likewise. */
const MIN_MS = 3_000
/** How many recent turns the median is taken over. */
const KEEP = 12
/** Enough turns to have a median worth comparing against. */
const MIN_SAMPLES = 5
/** Slower than this share of the median is worth saying. */
const SLOW_AT = 0.6
/** And it has to be sustained: this many slow turns in a row. */
const IN_A_ROW = 2

/** One turn's throughput, or null when the turn cannot say. */
export function rateOf(durationMs: number, outputTokens: number): number | null {
  if (!Number.isFinite(durationMs) || !Number.isFinite(outputTokens)) return null
  if (durationMs < MIN_MS || outputTokens < MIN_TOKENS) return null
  const perSecond = outputTokens / (durationMs / 1000)
  return perSecond > 0 && Number.isFinite(perSecond) ? perSecond : null
}

export function median(list: readonly number[]): number | null {
  if (list.length === 0) return null
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

/**
 * The trail folded with one new rate. Pure, so the whole judgement can be
 * tested without an engine or a clock.
 */
export function fold(prev: Shape['rate'], rate: number | null): Shape['rate'] {
  const base = prev ?? { recent: [], slowRuns: 0, isSlow: false, perSecond: null }
  if (rate === null) return base

  const recent = [...base.recent, rate].slice(-KEEP)
  const typical = median(recent)

  // Not enough history is not the same as "fine": nothing is claimed either way.
  if (typical === null || recent.length < MIN_SAMPLES) {
    return { recent, slowRuns: 0, isSlow: false, perSecond: rate }
  }

  const slow = rate < typical * SLOW_AT
  const slowRuns = slow ? base.slowRuns + 1 : 0
  return { recent, slowRuns, isSlow: slowRuns >= IN_A_ROW, perSecond: rate }
}

/**
 * Records one finished main-thread turn. Called from the mod's one
 * turn.complete hook in turns.ts.
 */
export async function noteRate($: EngineInterface, durationMs: number, outputTokens: number): Promise<void> {
  const rate = rateOf(durationMs, outputTokens)
  if (rate === null) return
  await writeShape($, prev => ({ ...prev, rate: fold(prev.rate, rate) }))
}
