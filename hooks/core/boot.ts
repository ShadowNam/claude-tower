import { startAgents } from './agents'
import { startDiag } from './diag'
import type { Feature } from './kinds'
import { startNotify } from './notify'
import { startTank } from './tank'
import { startUsage } from './usage'
import { startWatch } from './watch'

/**
 * The mod's one session.start hook. The engine takes a single unmatched
 * registration per event, so every feature is started from here rather than
 * hooking session.start for itself.
 *
 * Nothing here may throw: a seed that fails must still leave the session
 * usable, which is what the .catch below guarantees.
 */
export const registerBoot: Feature = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await startDiag($, e.surface ?? 'none', options)
    await startNotify($)
    if (options.usageBand === true) await startUsage($)
    if (options.agentsPanel === true) await startAgents($)
    // Last, and guarded inside: the watchers are the only part that reaches
    // outside this machine, and nothing else should wait on them.
    await startWatch($, options)
    try {
      await startTank($, options)
    } catch {
      // A Tank that cannot be reached at startup is reported by the panel,
      // not by failing the session.
    }

    return started
  }).catch(($, e, next) => next(e))
}
