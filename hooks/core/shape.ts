import type { EngineInterface } from 'claude-code'

import { noteToolTime } from './agents'
import type { Feature } from './kinds'
import { writeShape } from './state'

/**
 * Three facts about the session that nothing else on screen carries.
 *
 * **Effort.** It is invisible in the interface and silently drops to a lower
 * level on a model that cannot do the one asked for, so a session you believe
 * is on `xhigh` may not be. The classic hooks carry it already resolved —
 * "after any silent downgrade" — which is the figure worth showing.
 *
 * **A turn that failed.** The engine names the reason: rate limited,
 * overloaded, billing. Without it the session simply stops and nothing says
 * why, which is the worst thing a status band can let happen.
 *
 * **Compaction.** `precompute` fires before a compaction that has not happened
 * yet, so this is the one case where the band can warn rather than report.
 */

/** Faults worth a row. The rest are the engine's business, not the band's. */
const TOLD: Readonly<Record<string, string>> = {
  rate_limit: 'rate limited',
  overloaded: 'overloaded',
  billing_error: 'billing',
  account_on_hold: 'account on hold',
  verification_required: 'needs verification',
  authentication_failed: 'sign-in failed',
  server_error: 'server error',
  max_output_tokens: 'hit output limit',
}

/** How a fault reads on the band, or null when it is not worth a row. */
export function faultWord(kind: string): string | null {
  return TOLD[kind] ?? null
}

/** How long a fault stays worth showing after the turn it ended. */
export const FAULT_MS = 5 * 60_000

/** The effort as a word, or '' when the engine did not say. */
export function effortOf(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.round(raw))
  if (typeof raw !== 'string') return ''
  const word = raw.trim().toLowerCase()
  return /^(low|medium|high|xhigh|max)$/.test(word) ? word : ''
}

/** Records the effort a turn actually ran at. */
export async function noteEffort($: EngineInterface, raw: unknown): Promise<void> {
  const effort = effortOf(raw)
  if (effort === '') return
  await writeShape($, prev => (prev.effort === effort ? prev : { ...prev, effort }))
}

/**
 * The events nothing else gives: a turn that failed, and a compaction that is
 * about to happen. Each is registered once without a matcher, which is all the
 * engine allows per module, so this module owns both outright.
 */
export const registerShape: Feature = (on, options) => {
  // The timing belongs to the agents panel; the rest to the band.
  if (options.agentsPanel === true) {
    on('classic.PostToolUse', async ($, e, next) => {
      const ms = (e as { duration_ms?: unknown }).duration_ms
      if (typeof ms === 'number') await noteToolTime($, (e as { agent_id?: string }).agent_id, ms)
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  if (options.usageBand !== true) return

  on('classic.StopFailure', async ($, e, next) => {
    const kind = String((e as { error?: unknown }).error ?? '')
    if (faultWord(kind) !== null) {
      const at = await $.clock.now()
      await writeShape($, prev => ({ ...prev, fault: { kind, at } }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    // `precompute` installs nothing: its result is kept for a compaction that
    // has not happened yet, which is what makes it a warning rather than news.
    const soon = e.trigger === 'precompute'
    await writeShape($, prev => ({ ...prev, compacting: soon ? 'soon' : 'running' }))
    try {
      return await next(e)
    } finally {
      // A real compaction has landed by now; a precompute never started one.
      await writeShape($, prev => ({ ...prev, compacting: soon ? prev.compacting : null }))
    }
  }).catch(($, e, next) => next(e))
}
