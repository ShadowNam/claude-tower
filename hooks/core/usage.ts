import type { EngineInterface } from 'claude-code'

import { projectWithin, trim } from './burn'
import { until } from './fmt'
import type { Feature } from './kinds'
import { beat } from './sessions'
import { bumpTick, readAgents, readBuilds, readUsage, writePicked, writeUsage } from './state'

import type { CacheFacts, Compaction, Sample, Usage, UsageWindow } from '../../types'

/**
 * How long a prompt cache stays warm, until the engine says otherwise.
 *
 * An hour is the assumption, not a fact: a session can be on a five-minute
 * cache, and there a band promising "WARM 58m left" is not slightly wrong, it
 * is the opposite of the truth. `classic.PreModelSwitch` carries the real
 * figure, so the assumption only stands until the first model switch — which
 * is why the drawing marks an unlearned one rather than stating it flatly.
 */
export const TTL_MS = 60 * 60_000
export const TTL_MIN = 60

/** How often countdowns are refreshed while something on screen is moving. */
const TICK_MS = 30_000
/**
 * How many ticks are skipped when nothing on screen changes faster than an
 * hour. A reset countdown reading `5d 7h` does not need touching twice a
 * minute, and a redraw every thirty seconds forever is what gets a mod blamed
 * for the app feeling warm.
 */
const SLOW_EVERY = 10
/** Below this much left on a countdown, the figure is worth watching closely. */
const SOON_MS = 60 * 60_000

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
  /** Minutes before it goes cold, against the real lifetime. */
  leftMin: number
  tokens: number
  model: string | null
}

/** Pure, so warm-to-cold can be tested at the boundary without a clock. */
export function cacheView(cache: CacheFacts | null, now: number, ttlMs = TTL_MS): CacheView | null {
  if (cache === null || cache.lastAt <= 0 || cache.tokens <= 0) return null
  const idleMs = Math.max(0, now - cache.lastAt)
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : TTL_MS
  return {
    mode: idleMs >= ttl ? 'cold' : 'warm',
    idleMs,
    idleMin: Math.floor(idleMs / 60_000),
    leftMin: Math.max(0, Math.ceil((ttl - idleMs) / 60_000)),
    tokens: cache.tokens,
    model: cache.model,
  }
}

/** The shape a measurement gives us, named so the fold can be tested alone. */
export type MeasureFacts = {
  changed: readonly string[]
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  context: {
    tokens: number
    window: number
    breakdown?: {
      totalTokens?: number
      rawMaxTokens?: number
      autoCompactThreshold?: number
      isAutoCompactEnabled?: boolean
    }
  }
  cost?: { usd: number }
}

/**
 * The breakdown read into what the band draws, or the previous reading when
 * this measurement carried none. Pure, so the arithmetic can be tested without
 * an engine.
 */
export function compactionOf(prev: Compaction | null, e: MeasureFacts): Compaction | null {
  const b = e.context.breakdown
  if (b === undefined) return prev
  const max = typeof b.rawMaxTokens === 'number' && b.rawMaxTokens > 0 ? b.rawMaxTokens : 0
  if (max === 0) return prev
  const used = typeof b.totalTokens === 'number' && b.totalTokens >= 0 ? b.totalTokens : 0
  const firesAt =
    typeof b.autoCompactThreshold === 'number' && b.autoCompactThreshold > 0 ? b.autoCompactThreshold : null
  return { max, used, firesAt, isEnabled: b.isAutoCompactEnabled === true, breakdown: b }
}

/**
 * Tokens left before compaction fires, or null when nothing can be claimed —
 * auto-compaction switched off, no threshold named, or already past it.
 */
export function headroom(c: Compaction | null): number | null {
  if (c === null || !c.isEnabled || c.firesAt === null) return null
  const left = c.firesAt - c.used
  return left > 0 ? left : null
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

  return { windows, cache, ledger, samples, compaction: compactionOf(prev.compaction, e) }
}

/**
 * Which window gets the space, for the layouts that give one window more.
 *
 * One window is the one that will stop you, and which it is changes through
 * the day: a 7-day window at 8% matters more than a 5-hour one at 60%, right
 * up until the 5-hour one starts draining fast enough to empty before it
 * resets.
 *
 * So a window on course to run out wins, soonest first — a deadline changes
 * what you do next, where a level only says where you are. Otherwise the
 * emptiest wins, and a tie goes to the window listed first, which is the
 * slower one and the one you can do least about.
 */
export function heroOf(windows: readonly UsageWindow[], now: number): UsageWindow | null {
  if (windows.length === 0) return null

  const running = windows
    .filter(w => w.emptyAt !== null && w.emptyAt > now)
    .sort((a, b) => (a.emptyAt as number) - (b.emptyAt as number))
  if (running.length > 0) return running[0] as UsageWindow

  let worst = windows[0] as UsageWindow
  for (const w of windows) {
    if (w.percentUsed > worst.percentUsed) worst = w
  }
  return worst
}

/** The layouts the band knows, and what an unknown setting falls back to. */
export type Layout = 'rows' | 'dials' | 'hero' | 'cards'

export const LAYOUTS: readonly Layout[] = ['dials', 'hero', 'cards', 'rows']

export function layoutOf(raw: unknown): Layout {
  return LAYOUTS.includes(raw as Layout) ? (raw as Layout) : 'dials'
}

/**
 * The next layout round the loop.
 *
 * Four layouts behind a settings menu is four layouts nobody will ever
 * compare: by the time you have found the menu, changed the value and come
 * back, the thing you were comparing it against is gone from memory. A press
 * on the band itself puts them side by side in time, which is the only way a
 * layout choice can actually be made.
 */
export function nextLayout(current: Layout): Layout {
  const at = LAYOUTS.indexOf(current)
  return LAYOUTS[(at + 1) % LAYOUTS.length] as Layout
}

/**
 * First reading of the windows, and the ticker that keeps countdowns current.
 * Called from the mod's one session.start hook in boot.ts.
 */
export async function startUsage($: EngineInterface): Promise<void> {
  const now = await $.clock.now()

  // A layout pressed in an earlier session outranks the setting, so the band
  // comes back the way it was left.
  try {
    const kept = await $.store.get('layout')
    if (typeof kept === 'string' && kept !== '') await writePicked($, kept)
  } catch {
    // No kept choice is no problem: the setting decides.
  }
  // 'summary' estimates locally and sends nothing; 'full' would bill a
  // token-count request per tool and memory file, which a band must never do.
  const u = await $.session.usage({ breakdown: 'summary' })
  await writeUsage($, prev =>
    fold(prev, { changed: ['rateLimits', 'context'], rateLimits: u.rateLimits, context: u.context }, now),
  )
  let skipped = 0
  $.clock.every(TICK_MS, () => {
    void (async () => {
      const at = await $.clock.now()
      await refresh($, at)
      await beat($, at)
      if (await isMoving($, at)) {
        skipped = 0
        await bumpTick($)
        return
      }
      skipped += 1
      if (skipped >= SLOW_EVERY) {
        skipped = 0
        await bumpTick($)
      }
    })()
  })
}

/**
 * Re-reads the windows from the engine.
 *
 * Without this the figures only moved when **this** session got a response,
 * and the rate-limit windows belong to the account rather than the session —
 * so a session left open while the work happened elsewhere went on showing an
 * hour-old percentage as though it were current. A wrong number stated plainly
 * is worse than no number, and this one is the band's headline.
 *
 * No `breakdown` is asked for: without one the call computes nothing and is
 * free, which is what makes polling it reasonable at all. The breakdown stays
 * on the measurement, where something has actually changed.
 */
export async function refresh($: EngineInterface, now: number): Promise<void> {
  try {
    const u = await $.session.usage()
    await writeUsage($, prev =>
      fold(prev, { changed: ['rateLimits', 'context'], rateLimits: u.rateLimits, context: u.context }, now),
    )
  } catch {
    // A reading that cannot be taken leaves the last one standing.
  }
}

/**
 * Whether anything the band draws changes within the hour.
 *
 * The band's figures are nearly all countdowns, and a countdown an hour out is
 * drawn in hours — so refreshing it every thirty seconds redraws an idle
 * session to produce an identical row. This asks whether any of them is close
 * enough that the next tick would actually change a character.
 */
export async function isMoving($: EngineInterface, now: number): Promise<boolean> {
  const u = await readUsage($)
  if (u.cache !== null && u.cache.lastAt > 0 && now - u.cache.lastAt < (u.cacheTtlMs ?? TTL_MS)) return true
  for (const w of u.windows) {
    if (w.emptyAt !== null && w.emptyAt - now < SOON_MS) return true
    if (w.resetsAt === undefined) continue
    const at = Date.parse(w.resetsAt)
    if (Number.isFinite(at) && at - now < SOON_MS) return true
  }
  const builds = await readBuilds($)
  if (builds.some(b => b.state === 'running')) return true
  const agents = await readAgents($)
  return agents.some(a => a.status === 'running')
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
      // 'summary' estimates locally and sends nothing; 'full' would bill a
  // token-count request per tool and memory file, which a band must never do.
  const u = await $.session.usage({ breakdown: 'summary' })
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
