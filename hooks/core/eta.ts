/**
 * How long a build has left.
 *
 * A tool call is wrapped, not streamed: `next(e)` resolves only when the
 * command has finished, so there is no live percentage to read. What there is
 * instead is how long this same build took the last twenty times, which after
 * two runs beats most tools' own self-reported progress.
 *
 * The rule the whole file follows: reduce the claim before you reduce the
 * honesty. Each stage below says less than the last, and none of them lies.
 */

/** One finished run of the same build. */
export type Run = { at: number; ms: number }

export type Confidence = 'high' | 'medium' | 'low'

/** How much of a claim the estimate is still making. */
export type Stage =
  /** Inside the expected time: a bar and a countdown. */
  | 'normal'
  /** Past it: no countdown, but how far over. */
  | 'over'
  /** Well past it: a re-based range, marked uncertain. */
  | 'wide'
  /** No baseline, or so far past it that nothing can be said. */
  | 'unknown'

export type Estimate = {
  /** 0 to 1 for the bar, or null when there is nothing to scale it against. */
  progress: number | null
  /** Milliseconds left, or null when no number would be honest. */
  remainingMs: number | null
  /** How far past the expected time, in milliseconds; 0 when not over. */
  overMs: number
  /** The baseline it was judged against, for saying 'the usual 2m 41s'. */
  baselineMs: number | null
  confidence: Confidence
  stage: Stage
}

/** Runs older than this many entries ago count half as much. */
const HALFLIFE = 10
/** Past this multiple of the baseline, the estimate is re-based once. */
const SOFT = 1.5
/** Past this multiple, there is nothing useful left to claim. */
const HARD = 2

/**
 * A recency-weighted percentile of past durations.
 *
 * A plain median throws away the fact that last week's machine was slower; a
 * plain mean is wrecked by one cold build. Weighting by age keeps both in
 * proportion. Runs come oldest first.
 */
export function wpct(runs: readonly Run[], q: number): number | null {
  if (runs.length === 0) return null
  const lambda = Math.pow(0.5, 1 / HALFLIFE)
  const n = runs.length
  const weighted = runs
    .map((r, i) => ({ ms: r.ms, w: Math.pow(lambda, n - 1 - i) }))
    .sort((a, b) => a.ms - b.ms)

  const total = weighted.reduce((sum, p) => sum + p.w, 0)
  let acc = 0
  for (const p of weighted) {
    acc += p.w
    if (acc >= q * total) return p.ms
  }
  return weighted[weighted.length - 1]?.ms ?? null
}

/**
 * How much to trust the baseline: enough runs, and close enough together.
 *
 * Spread is measured two ways on purpose. With three runs or more the gap
 * between the weighted median and the weighted 80th tells it well. With fewer,
 * that gap collapses to zero — both percentiles land on the same run — and two
 * runs thirty times apart would read as perfectly steady, so the plain range
 * is used instead.
 */
export function confidenceOf(runs: readonly Run[]): Confidence {
  if (runs.length < 2) return 'low'

  let spread: number
  if (runs.length >= 3) {
    const p50 = wpct(runs, 0.5)
    const p80 = wpct(runs, 0.8)
    if (p50 === null || p80 === null || p50 <= 0) return 'low'
    spread = (p80 - p50) / p50
  } else {
    const each = runs.map(r => r.ms)
    const min = Math.min(...each)
    const max = Math.max(...each)
    spread = (max - min) / Math.max(min, 1)
  }

  if (runs.length >= 5 && spread <= 0.2) return 'high'
  if (spread <= 0.5) return 'medium'
  return 'low'
}

/**
 * What to show for a build that has been running `elapsedMs`.
 *
 * With no baseline it returns an honest nothing: an indeterminate bar and no
 * estimate. Inventing `~1m` from no history is how these bars lose their
 * credibility, and once lost it does not come back.
 */
export function estimate(runs: readonly Run[], elapsedMs: number, known?: number | null): Estimate {
  const baselineMs = wpct(runs, 0.5)
  const confidence = confidenceOf(runs)

  // A source that reports its own progress — a CI job's finished steps, a
  // marker file — beats any guess from the clock. It is blended with history
  // rather than trusted alone, because early progress runs ahead of time
  // spent: five quick setup steps are not a third of the build.
  if (known !== undefined && known !== null && known > 0 && known < 1) {
    const byProgress = (elapsedMs * (1 - known)) / known
    const byHistory = baselineMs === null ? null : Math.max(0, baselineMs - elapsedMs)

    const cProgress = Math.max(0, Math.min(1, (known - 0.05) / 0.15))
    const cHistory = byHistory === null ? 0 : 0.6 * (Math.min(runs.length, 5) / 5)
    const total = cProgress + cHistory

    const remainingMs =
      total <= 0 ? byProgress : (cProgress * byProgress + cHistory * (byHistory ?? 0)) / total

    return {
      progress: known,
      remainingMs: Math.max(0, remainingMs),
      overMs: 0,
      baselineMs,
      confidence: runs.length >= 2 ? confidence : 'medium',
      stage: 'normal',
    }
  }

  if (baselineMs === null || baselineMs <= 0) {
    return { progress: null, remainingMs: null, overMs: 0, baselineMs: null, confidence: 'low', stage: 'unknown' }
  }

  // Inside the expected time: a real bar and a real countdown.
  if (elapsedMs <= baselineMs) {
    return {
      progress: Math.max(0, Math.min(1, elapsedMs / baselineMs)),
      remainingMs: baselineMs - elapsedMs,
      overMs: 0,
      baselineMs,
      confidence,
      stage: 'normal',
    }
  }

  const overMs = elapsedMs - baselineMs

  // Past it, but not far. The bar keeps moving towards 100 without arriving,
  // and the countdown is replaced by how far over it has run. 'Over by 31s'
  // tells you more than a countdown frozen at '1m left'.
  if (elapsedMs <= baselineMs * SOFT) {
    return {
      progress: 0.95 + 0.05 * (1 - Math.exp(-overMs / baselineMs)),
      remainingMs: null,
      overMs,
      baselineMs,
      confidence,
      stage: 'over',
    }
  }

  // Well past: re-base once, widen the claim, and mark it uncertain.
  if (elapsedMs <= baselineMs * HARD) {
    const rebased = Math.max(baselineMs, elapsedMs * 1.15)
    return {
      progress: Math.max(0, Math.min(0.99, elapsedMs / rebased)),
      remainingMs: Math.max(0, rebased - elapsedMs),
      overMs,
      baselineMs,
      confidence: 'low',
      stage: 'wide',
    }
  }

  // Twice the usual time. The baseline no longer describes this run at all.
  return { progress: null, remainingMs: null, overMs, baselineMs, confidence: 'low', stage: 'unknown' }
}

/** Keep the most recent runs, newest last. */
export function remember(runs: readonly Run[], run: Run, max: number): Run[] {
  return [...runs, run].slice(-max)
}
