import type { EngineInterface } from 'claude-code'

import { projectWithin, trim } from './burn'
import { until } from './fmt'
import type { Feature } from './kinds'
import { bumpTick, writeUsage } from './state'

import type { CacheFacts, Sample, Usage, UsageWindow } from '../../types'

/** How long a prompt cache stays warm on this plan. */
export const TTL_MS = 60 * 60_000
export const TTL_MIN = 60

/** How often countdowns are refreshed. Minutes move slowly; this is plenty. */
const TICK_MS = 30_000

/** 7-day first, then 5-hour: the slow limit, then the one that bites today. */
const ORDER: Readonly<Record<string, number>> = { seven_day: 0, five_hour: 1 }

/** The engine's names for the windows, in the words a person uses. */
const NAMES: Readonly<Record<string, string>> = {
  seven_day: '7-day',
  five_hour: '5-hour',
  spend_limit: 'spend',
}

/** The prompt cache as a drawing reads it, or null until there is one. */
export type CacheView = {
  mode: 'warm' | 'cold'
  idleMs: number
  idleMin: number
  tokens: number
  model: string | null
}

/** Pure, so warm-to-cold can be tested at the boundary without a clock. */
export function cacheView(cache: CacheFacts | null, now: number): CacheView | null {
  if (cache === null || cache.lastAt <= 0 || cache.tokens <= 0) return null
  const idleMs = Math.max(0, now - cache.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idleMs,
    idleMin: Math.floor(idleMs / 60_000),
    tokens: cache.tokens,
    model: cache.model,
  }
}

/** The shape a measurement gives us, named so the fold can be tested alone. */
export type MeasureFacts = {
  changed: readonly string[]
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  context: { tokens: number; window: number }
  cost?: { usd: number }
}

/**
 * A measurement folded into what the band draws. Pure, so the projection and
 * the ordering can be tested without an engine.
 */
export function fold(prev: Usage, e: MeasureFacts, now: number): Usage {
  let windows = prev.windows
  let samples = prev.samples

  if (e.changed.includes('rateLimits')) {
    const next: Record<string, readonly Sample[]> = { ...prev.samples }
    windows = [...e.rateLimits]
      .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))
      .map((w): UsageWindow => {
        const trail = trim(next[w.kind] ?? [], { at: now, percent: w.percentUsed })
        next[w.kind] = trail
        return {
          kind: w.kind,
          percentUsed: w.percentUsed,
          resetsAt: w.resetsAt,
          emptyAt: projectWithin(trail, now, w.percentUsed, w.resetsAt),
        }
      })
    samples = next
  }

  const ledger = {
    usd: e.changed.includes('cost') && e.cost !== undefined ? e.cost.usd : prev.ledger.usd,
    tokens: e.context.tokens > 0 ? e.context.tokens : prev.ledger.tokens,
    window: e.context.window > 0 ? e.context.window : prev.ledger.window,
  }

  // The cache carries whatever the context last measured, so a cold band can
  // price re-sending it without waiting for another turn.
  const cache = prev.cache === null ? null : { ...prev.cache, tokens: ledger.tokens, window: ledger.window }

  return { windows, cache, ledger, samples }
}

/**
 * First reading of the windows, and the ticker that keeps countdowns current.
 * Called from the mod's one session.start hook in boot.ts.
 */
export async function startUsage($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const u = await $.session.usage()
  await writeUsage($, prev =>
    fold(prev, { changed: ['rateLimits', 'context'], rateLimits: u.rateLimits, context: u.context }, now),
  )
  $.clock.every(TICK_MS, () => {
    void bumpTick($)
  })
}

/**
 * A main-thread request has begun, so the cache is warm from now. Called from
 * the mod's one turn.step hook in turns.ts.
 */
export async function stampCache($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await writeUsage($, prev => ({
    ...prev,
    cache: {
      lastAt: now,
      tokens: prev.cache?.tokens ?? prev.ledger.tokens,
      window: prev.cache?.window ?? prev.ledger.window,
      model: prev.cache?.model ?? null,
    },
  }))
}

/** A main-thread turn has ended; record which model it was on. */
export async function completeCache($: EngineInterface, model: string | null, durationMs: number): Promise<void> {
  const now = await $.clock.now()
  const named = model ?? (await $.session.model())
  await writeUsage($, prev => {
    // turn.step stamps the exact request time; when no step of this turn did,
    // the turn's own end is the floor.
    const lastAt = prev.cache === null || now - prev.cache.lastAt > durationMs ? now : prev.cache.lastAt
    return {
      ...prev,
      cache: { lastAt, tokens: prev.ledger.tokens, window: prev.ledger.window, model: named ?? null },
    }
  })
}

/**
 * Where the band's figures come from. All of it is the engine's own
 * bookkeeping, read as it is published, so the band costs nothing to run.
 */
export const registerUsage: Feature = (on, options) => {
  if (options.usageBand !== true) return

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    await writeUsage($, prev => fold(prev, e, now))


    return next(e)
  }).catch(($, e, next) => next(e))

  // A resumed or forked session knows how long it was away; a cleared or
  // compacted one has no cache worth pricing.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await writeUsage($, prev => ({ ...prev, cache: null }))
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const u = await $.session.usage()
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      await writeUsage($, prev => ({
        ...prev,
        cache: {
          lastAt,
          tokens: typeof e.context_tokens === 'number' ? e.context_tokens : u.context.tokens,
          window: u.context.window,
          model: model ?? null,
        },
      }))
    }
    return done
  }).catch(($, e, next) => next(e))
}
