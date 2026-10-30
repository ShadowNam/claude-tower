import type { EngineInterface } from 'claude-code'

import { writeShape } from './state'

/**
 * How many of your sessions are alive right now.
 *
 * The rate-limit windows belong to the account, not to this session, so with
 * three sessions open the figures move without you doing anything. The windows
 * themselves are correct — they are the engine's own account-wide readings,
 * re-read on a timer — so this is not a correction to them. It is the answer
 * to "why did that drop while I was reading", which is otherwise unanswerable
 * from inside one session.
 *
 * Each session writes a heartbeat under its own id and counts the others'.
 * Three things about that are worth knowing rather than discovering:
 *
 * **Writes can be lost.** The store is one file per plugin and a write is
 * last-one-wins, so two sessions saving at the same moment can drop one
 * another's heartbeat. It self-heals, because a heartbeat repeats; that is
 * exactly why this is a repeated write rather than a careful one.
 *
 * **Nothing is pushed.** A session learns about the others only on its own
 * tick, so the count lags by up to that long.
 *
 * **Only a count, and only of your own sessions.** No path, no title, no
 * prompt — there is nothing here another session could not already see, and
 * nothing that would make the store worth reading.
 */

/** Prefix for a session's heartbeat, so the store's other keys are untouched. */
const KEY = 'seen:'
/** A heartbeat older than this is from a session that has gone. */
const LIVE_MS = 4 * 60_000
/** And one older than this is swept, so the store cannot grow for ever. */
const DEAD_MS = 12 * 60 * 60_000

/** The live count from a set of heartbeats, including this session's own. */
export function liveCount(
  entries: readonly { key: string; at: number }[],
  now: number,
  mine: string,
): number {
  const live = entries.filter(e => now - e.at < LIVE_MS)
  // This session counts even if its own heartbeat has not landed yet.
  return live.some(e => e.key === mine) ? live.length : live.length + 1
}

/** The keys worth deleting: long dead, and never this session's own. */
export function deadKeys(
  entries: readonly { key: string; at: number }[],
  now: number,
  mine: string,
): string[] {
  return entries.filter(e => e.key !== mine && now - e.at > DEAD_MS).map(e => e.key)
}

/** Reads every heartbeat in the store, ignoring anything it cannot parse. */
async function heartbeats($: EngineInterface): Promise<{ key: string; at: number }[]> {
  let keys: readonly string[] = []
  try {
    keys = (await $.store.keys()) as readonly string[]
  } catch {
    return []
  }

  const out: { key: string; at: number }[] = []
  for (const key of keys) {
    if (!key.startsWith(KEY)) continue
    try {
      const raw = await $.store.get(key)
      const at = (raw as { at?: unknown } | null)?.at
      if (typeof at === 'number' && Number.isFinite(at)) out.push({ key, at })
    } catch {
      // A key that will not read is a key that does not count.
    }
  }
  return out
}

/**
 * Writes this session's heartbeat and counts the rest. Called from the
 * ticker, which already slows down when nothing is happening.
 */
export async function beat($: EngineInterface, now: number): Promise<void> {
  let mine: string
  try {
    mine = KEY + String(await $.session.id())
  } catch {
    return
  }

  try {
    await $.store.set(mine, { at: now })
  } catch {
    // A heartbeat that cannot be written costs this session's own place in
    // the count, and nothing else.
  }

  const seen = await heartbeats($)
  const count = liveCount(seen, now, mine)
  await writeShape($, prev => (prev.sessions === count ? prev : { ...prev, sessions: count }))

  // Swept rarely and never this session's own, because a delete is the one
  // write here that cannot heal itself if it races.
  for (const key of deadKeys(seen, now, mine)) {
    try {
      await $.store.delete(key)
    } catch {
      // It will come round again.
    }
  }
}
