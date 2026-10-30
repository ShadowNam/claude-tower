import type { Sample } from '../../types'

/** Readings older than this are dropped: a rate should describe recent work. */
const WINDOW_MS = 30 * 60_000
/** Beyond this many readings the oldest go; a rate needs a trail, not a log. */
const MAX_SAMPLES = 60
/** Fewer readings than this cannot describe a rate. */
const MIN_SAMPLES = 3
/** Nor can readings that span less time than this. */
const MIN_SPAN_MS = 5 * 60_000
/** A window that runs out further off than this is not worth a warning. */
const MAX_PROJECT_MS = 24 * 60 * 60_000

/** The trailing readings, oldest first, with a new one added. */
export function trim(samples: readonly Sample[], next: Sample): Sample[] {
  return [...samples, next].filter(s => next.at - s.at <= WINDOW_MS).slice(-MAX_SAMPLES)
}

/**
 * When this window is on course to be spent, from the straight line through
 * the trailing readings. Null when there is too little history, when the
 * window is not being spent (a rolling window that just rolled reads as a
 * fall), or when the answer is too far off to act on.
 */
export function project(samples: readonly Sample[], now: number, percentUsed: number): number | null {
  if (samples.length < MIN_SAMPLES) return null
  const first = samples[0]
  if (first === undefined) return null

  const spanMs = now - first.at
  if (spanMs < MIN_SPAN_MS) return null

  const rise = percentUsed - first.percent
  if (rise <= 0) return null

  const left = 100 - percentUsed
  if (left <= 0) return now

  const ms = (left * spanMs) / rise
  return ms > MAX_PROJECT_MS ? null : now + ms
}

/**
 * The same, but silent when the window resets before it would run out: a limit
 * you will never reach is not news.
 */
export function projectWithin(
  samples: readonly Sample[],
  now: number,
  percentUsed: number,
  resetsAt: string | undefined,
): number | null {
  const at = project(samples, now, percentUsed)
  if (at === null) return null
  if (resetsAt !== undefined) {
    const reset = Date.parse(resetsAt)
    if (!Number.isNaN(reset) && at >= reset) return null
  }
  return at
}
