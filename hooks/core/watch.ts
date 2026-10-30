import type { EngineInterface } from 'claude-code'

import { sweepStale } from './builds'
import type { Feature, Options } from './kinds'
import { MARKER_MS, pollMarker, SNIPPET } from './marker'
import { writeBuilds } from './state'

/** A watched source that has said nothing for this long is no longer known. */
const STALE_MS = 10 * 60_000

/**
 * The background watcher: the marker file a build script writes. It runs on a
 * timer rather than on anything the model does, so a build is watched whether
 * or not the session is busy — and it costs no token, because it never goes
 * through the model.
 */
export async function startWatch($: EngineInterface, options: Options): Promise<void> {
  if (options.buildBar !== true) return

  try {
    const cwd = String(await $.session.cwd())

    await $.command.register({
      name: 'tower-hook',
      description: 'Print the snippet that lets a build script report its own progress.',
    })

    $.clock.every(MARKER_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        await pollMarker($, cwd, now)
        await writeBuilds($, prev => sweepStale(prev, now, STALE_MS))
      })()
    })
  } catch {
    // No working directory, no watcher: the rest of the mod is unaffected.
  }
}

/** `/tower-hook`: the emitter a build script needs to report its own progress. */
export const registerWatch: Feature = (on, options) => {
  if (options.buildBar !== true) return

  on('command.run', { command: 'tower-hook' }, async $ => {
    const cwd = String(await $.session.cwd())
    return {
      text: [
        'To show progress for a build Tower cannot see — one started outside this',
        'session, or a script of your own — have it write .buildstatus.json in',
        `${cwd}:`,
        '',
        SNIPPET,
        '',
        'Tower reads it every two seconds. A build whose heartbeat stops is shown',
        'as unknown rather than left running.',
      ].join('\n'),
    }
  })
}
