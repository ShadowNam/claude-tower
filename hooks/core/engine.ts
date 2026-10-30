import type { EngineInterface } from 'claude-code'

import type { Feature } from './kinds'
import { writeShape, writeUsage } from './state'

import type { Background, Phase, Weight } from '../../types'

/**
 * Four things the engine knows and Tower was working out for itself, or not
 * showing at all.
 *
 * **The prompt cache's real lifetime.** Tower assumed an hour. The engine says
 * which it is — `5m` or `1h` — and on a five-minute cache a band promising
 * "WARM 58m left" is not slightly off, it is telling you the opposite of the
 * truth. It only learns this at a model switch, so an hour stays the
 * assumption until one happens; that is why `isLearned` exists rather than the
 * figure quietly changing meaning.
 *
 * **What re-sending the context would cost**, at the engine's own rate rather
 * than from Tower's price table, which drifts as prices change.
 *
 * **What the turn is doing** — thinking, calling a tool, writing the reply.
 * Tower had a boolean.
 *
 * **Work still running in the background**, and prompts scheduled to fire.
 * Nothing else shows either: a dev server you backgrounded is invisible the
 * moment the transcript scrolls.
 */

/** The ways the spinner's mode reads on a band. */
const PHASES: Readonly<Record<string, Phase>> = {
  thinking: 'thinking',
  requesting: 'asking',
  responding: 'writing',
  'tool-use': 'tool',
  'tool-input': 'tool',
}

export function phaseOf(mode: unknown): Phase | null {
  return typeof mode === 'string' ? (PHASES[mode] ?? null) : null
}

/** The cache's lifetime in milliseconds, from the engine's own word for it. */
export function ttlOf(raw: unknown): number | null {
  if (raw === '1h') return 60 * 60_000
  if (raw === '5m') return 5 * 60_000
  return null
}

/**
 * The background roster, filtered to what a person would act on.
 *
 * `Stop` fires at the end of a turn and nothing reports a task *finishing*, so
 * this is a turn-boundary snapshot and will sometimes name something that has
 * already exited. That is why the band says `bg` and a count rather than
 * claiming anything is definitely still running.
 */
export function backgroundOf(tasks: unknown, crons: unknown, now: number): Background {
  const list = Array.isArray(tasks) ? tasks : []
  const kinds: string[] = []
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue
    const kind = (row as { type?: unknown }).type
    if (typeof kind === 'string' && kind !== '' && !kinds.includes(kind)) kinds.push(kind)
  }
  const scheduled = Array.isArray(crons) ? crons.length : 0
  return { count: list.length, kinds, scheduled, at: now }
}

/** The heaviest thing in the context that is not the conversation itself. */
export function heaviestOf(breakdown: unknown): Weight | null {
  if (typeof breakdown !== 'object' || breakdown === null) return null
  const b = breakdown as Record<string, unknown>

  const rows: { name: string; tokens: number }[] = []

  const tools = b['mcpTools']
  if (Array.isArray(tools)) {
    const perServer = new Map<string, number>()
    for (const t of tools) {
      if (typeof t !== 'object' || t === null) continue
      const r = t as Record<string, unknown>
      const server = typeof r['serverName'] === 'string' ? r['serverName'] : ''
      const tokens = typeof r['tokens'] === 'number' ? r['tokens'] : 0
      if (server !== '' && tokens > 0) perServer.set(server, (perServer.get(server) ?? 0) + tokens)
    }
    for (const [name, tokens] of perServer) rows.push({ name, tokens })
  }

  // The named categories, less the conversation itself: "your messages are
  // large" is not a thing anyone can act on.
  const cats = b['categories']
  if (Array.isArray(cats)) {
    for (const c of cats) {
      if (typeof c !== 'object' || c === null) continue
      const r = c as Record<string, unknown>
      const name = typeof r['name'] === 'string' ? r['name'] : ''
      const tokens = typeof r['tokens'] === 'number' ? r['tokens'] : 0
      const kind = typeof r['kind'] === 'string' ? r['kind'] : ''
      if (name === '' || tokens <= 0 || kind !== 'used') continue
      if (/message|conversation|free|reserved|buffer|output/i.test(name)) continue
      rows.push({ name, tokens })
    }
  }

  if (rows.length === 0) return null
  rows.sort((a, b2) => b2.tokens - a.tokens)
  const top = rows[0] as { name: string; tokens: number }
  return { name: top.name, tokens: top.tokens }
}

/**
 * The engine's own figures, and the two rosters nothing else carries. Each
 * event is registered once without a matcher, which is all the engine allows
 * per module, so this module owns them outright.
 */
export const registerEngine: Feature = (on, options) => {
  if (options.usageBand !== true) return

  on('classic.PreModelSwitch', async ($, e, next) => {
    const r = e as unknown as Record<string, unknown>
    const ttlMs = ttlOf(r['cache_ttl'])
    const warm = r['prompt_cache_warm'] === true
    const usd = typeof r['estimated_cache_write_usd'] === 'number' ? r['estimated_cache_write_usd'] : null
    await writeUsage($, prev => ({
      ...prev,
      // A switch forfeits the current cache, so the warmth reported here is
      // about the model being left, not the one being joined.
      cacheTtlMs: ttlMs ?? prev.cacheTtlMs,
      isTtlLearned: ttlMs !== null ? true : prev.isTtlLearned,
      rewarmUsd: usd !== null && warm ? usd : prev.rewarmUsd,
    }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    const bg = backgroundOf(r['background_tasks'], r['session_crons'], now)
    await writeShape($, prev => ({ ...prev, background: bg.count > 0 || bg.scheduled > 0 ? bg : null }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // A drawing of the engine's own spinner: read, never rewritten.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const drawn = await next(e)
    const phase = phaseOf((e.props as { mode?: unknown }).mode)
    if (phase !== null) await writeShape($, prev => (prev.phase === phase ? prev : { ...prev, phase }))
    return drawn
  }).catch(($, e, next) => next(e))
}
