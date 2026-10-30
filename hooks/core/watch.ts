import type { EngineInterface } from 'claude-code'

import { sweepStale } from './builds'
import { ciTargetOf, pollCi } from './ci'
import type { Feature, Options } from './kinds'
import { MARKER_MS, pollMarker, SNIPPET } from './marker'
import { writeBuilds } from './state'

/** A watched source that has said nothing for this long is no longer known. */
const STALE_MS = 10 * 60_000

/**
 * The background watchers: the marker file a build script writes, and the
 * repository's CI. Both run on timers rather than on anything the model does,
 * so a build is watched whether or not the session is busy — and neither
 * costs a token, because neither goes through the model.
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

    // CI needs a token the person supplied; without one there is nothing to
    // watch and nothing is attempted.
    const token = String(options.githubToken ?? '')
    const repo = await ciTargetOf($, token)
    if (repo === null) return

    // The interval follows the run: close while something is happening, slow
    // when nothing is. A 304 costs nothing against the rate limit either way.
    const loop = async (): Promise<void> => {
      const now = await $.clock.now()
      let wait = 120_000
      try {
        wait = await pollCi($, repo, token, now)
      } catch {
        // One failed poll is not worth stopping the loop over.
      }
      $.clock.after(wait, () => {
        void loop()
      })
    }
    void loop()
  } catch {
    // No working directory, no repository, no watchers: the rest of the mod
    // is unaffected.
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
