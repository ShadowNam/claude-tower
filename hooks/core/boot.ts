import { startAgents } from './agents'
import { redact } from './builds'
import { noteFailures, startDiag } from './diag'
import type { Feature } from './kinds'
import { startNotify } from './notify'
import { startTank } from './tank'
import { startUsage } from './usage'
import { startWatch } from './watch'

/** How much of a thrown reason is worth repeating in `/tower`. */
const REASON_MAX = 120

/** What a thrown value says, with anything key-shaped taken out. */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const clean = redact(raw).replace(/\s+/g, ' ').trim()
  if (clean === '') return 'threw nothing'
  return clean.length > REASON_MAX ? `${clean.slice(0, REASON_MAX)}…` : clean
}

/**
 * The mod's one session.start hook. The engine takes a single unmatched
 * registration per event, so every feature is started from here rather than
 * hooking session.start for itself.
 *
 * Each feature is caught on its own. One that throws is skipped alone and
 * named in the diagnostics, because a shared catch here used to take the rest
 * of the mod down with it: a failing usage seed left the agents panel
 * unregistered and the whole mod invisible, with nothing on screen to say so.
 *
 * Diagnostics are seeded first, so `/tower` answers even if nothing else
 * starts. That makes `/tower` the one thing always worth asking.
 */
export const registerBoot: Feature = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const failed: string[] = []

    try {
      await startDiag($, e.surface ?? 'none', options)
    } catch (err) {
      // Nothing can be reported if this is what broke; the session still runs.
      failed.push(`diag: ${reasonOf(err)}`)
    }

    try {
      await startNotify($)
    } catch (err) {
      failed.push(`notify: ${reasonOf(err)}`)
    }

    if (options.usageBand === true) {
      try {
        await startUsage($)
      } catch (err) {
        failed.push(`usage: ${reasonOf(err)}`)
      }
    }

    if (options.agentsPanel === true) {
      try {
        await startAgents($)
      } catch (err) {
        failed.push(`agents: ${reasonOf(err)}`)
      }
    }

    // The watchers are the only part that reaches outside this machine, so
    // nothing else waits on them.
    try {
      await startWatch($, options)
    } catch (err) {
      failed.push(`builds: ${reasonOf(err)}`)
    }

    try {
      await startTank($, options)
    } catch (err) {
      // A Tank that cannot be reached at startup is the panel's news, not the
      // session's, but it is still worth naming in the diagnostics.
      failed.push(`tank: ${reasonOf(err)}`)
    }

    if (failed.length > 0) {
      try {
        await noteFailures($, failed)
      } catch {
        // The diagnostics are a convenience; they never fail the load.
      }
    }

    return started
  }).catch(($, e, next) => next(e))
}
