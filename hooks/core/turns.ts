import { noteComplete, noteStep } from './agents'
import type { Feature } from './kinds'
import { noteEffort } from './shape'
import { completeCache, stampCache } from './usage'

/**
 * The mod's one turn.step and turn.complete hooks. The engine takes a single
 * unmatched registration per event, and both the usage band (for the prompt
 * cache) and the agents panel (for cost and context) need these two, so they
 * are owned here and fan out to each feature.
 */
export const registerTurns: Feature = (on, options) => {
  const wantsUsage = options.usageBand === true
  const wantsAgents = options.agentsPanel === true
  if (!wantsUsage && !wantsAgents) return

  on('turn.step', async function* ($, e, next) {
    // A main-thread request reads or writes the prompt cache, so its start is
    // what resets the hour. A subagent loop has a cache of its own.
    if (wantsUsage && e.agentId === undefined) {
      await stampCache($)
      await noteEffort($, e.effort)
    }

    const result = yield* next(e)

    if (wantsAgents) {
      const usage = result.usage ?? null
      await noteStep(
        $,
        e.agentId,
        usage?.model ?? e.model ?? '',
        typeof e.effort === 'string' ? e.effort : undefined,
        usage,
      )
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (wantsAgents) {
      // A refusal names itself; an abort does not, and an answer is the rest.
      const named = (e as { reason?: unknown }).reason
      const reason = typeof named === 'string' ? named : e.isAborted ? 'aborted' : 'answer'
      await noteComplete($, e.agentId, reason)

    }

    if (wantsUsage && e.agentId === undefined) {
      await completeCache($, e.usage?.model ?? null, e.durationMs)
    }

    return done
  }).catch(($, e, next) => next(e))
}
