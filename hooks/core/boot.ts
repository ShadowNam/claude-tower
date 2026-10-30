import { startAgents } from './agents'
import { noteFailures, startDiag } from './diag'
import { reasonOf } from './fmt'
import type { Feature } from './kinds'
import { startUsage } from './usage'
import { startWatch } from './watch'

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
      failed.push(`diag: ${reasonOf(err, 300)}`)
    }


    if (options.usageBand === true) {
      try {
        await startUsage($)
      } catch (err) {
        failed.push(`usage: ${reasonOf(err, 300)}`)
      }
    }

    if (options.agentsPanel === true) {
      try {
        await startAgents($)
      } catch (err) {
        failed.push(`agents: ${reasonOf(err, 300)}`)
      }
    }

    // The watchers are the only part that reaches outside this machine, so
    // nothing else waits on them.
    try {
      await startWatch($, options)
    } catch (err) {
      failed.push(`builds: ${reasonOf(err, 300)}`)
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
