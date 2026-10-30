import { detailOf, noteToolEnd, noteToolStart } from './agents'
import { isWorthTelling, noteBuildEnd, noteBuildStart } from './builds'
import type { Feature } from './kinds'
import { notify } from './notify'

/**
 * The mod's one tool.call hook. The agents panel wants every call, to show
 * what each loop is doing; the build bar wants the shell ones, to time them.
 * The engine takes a single unmatched registration per event, so both are
 * served from here.
 *
 * The call itself is passed straight through. Only the bookkeeping either
 * side of it belongs to the mod, and a failure in that bookkeeping must never
 * stop the call: a tool that works is worth more than a row that is right.
 */
export const registerTools: Feature = (on, options) => {
  const wantsAgents = options.agentsPanel === true
  const wantsBuilds = options.buildBar === true
  if (!wantsAgents && !wantsBuilds) return

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Readonly<Record<string, unknown>>

    if (wantsAgents) await noteToolStart($, e.agentId, tool, detailOf(tool, input))

    // Only a shell command can be a build, and only some of those are.
    let build: string | null = null
    if (wantsBuilds && (tool === 'Bash' || tool === 'PowerShell')) {
      const command = typeof input['command'] === 'string' ? input['command'] : ''
      const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : await $.session.cwd()
      build = await noteBuildStart($, e.tool_use_id, command, String(cwd))
    }

    // A call that throws still ended, and both rows have to be told.
    let result
    try {
      result = await next(e)
    } catch (err) {
      if (wantsAgents) await noteToolEnd($, e.agentId, true)
      if (build !== null) await noteBuildEnd($, build, true, '')
      throw err
    }

    const isError = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true

    if (wantsAgents) await noteToolEnd($, e.agentId, isError)
    if (build !== null) {
      const out = typeof result === 'object' && result !== null ? (result as { result?: unknown }).result : undefined
      const done = await noteBuildEnd($, build, isError, typeof out === 'string' ? out : '')

      // A build short enough to watch finish is not worth a message.
      if (done !== null) {
        const now = await $.clock.now()
        if (isWorthTelling(done, now)) {
          await notify($, options, isError ? 'build.failed' : 'build.finished', `${done.project}|${done.target}`, {
            project: done.project,
            detail: done.target,
            extra: done.errorLine,
          })
        }
      }
    }

    return result
  }).catch(($, e, next) => next(e))
}
