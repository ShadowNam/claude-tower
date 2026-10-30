import type { EngineInterface } from 'claude-code'

import { writeShape } from './state'

import type { Repo } from '../../types'

/**
 * Which branch the session is on, and whether the repository is mid-operation.
 *
 * Read out of `.git` directly. `$.process.*` is CLI-only, so shelling out to
 * git does nothing in the desktop app, and walking the worktree is a cost no
 * band should impose on a repository it did not choose. Reading four small
 * files is neither.
 *
 * **What this deliberately cannot tell you** is how far ahead or behind the
 * remote you are. That needs the commit graph, and the only thing reachable
 * here is whether the local ref and the remote-tracking ref point at the same
 * commit — so it says `synced` or `diverged` and never a count. A band that
 * said "3 ahead" from this would be guessing.
 *
 * The mid-operation states matter more than the branch name: starting to edit
 * in the middle of a half-finished rebase is how a working tree gets into a
 * mess that takes an afternoon.
 */

/** Branches where a stray commit is somebody else's problem too. */
const PROTECTED = /^(main|master|prod|production|release(\/.+)?)$/i

/** A ref line as `.git/HEAD` holds it. */
const REF = /^ref:\s*refs\/heads\/(.+)$/

/** What `.git` holds when the working copy is a linked worktree. */
const GITDIR = /^gitdir:\s*(.+)$/

/** Operations that leave the tree half-changed, and the file that proves each. */
const MIDWAY: readonly (readonly [string, string])[] = [
  ['rebase-merge', 'rebasing'],
  ['rebase-apply', 'rebasing'],
  ['MERGE_HEAD', 'merging'],
  ['CHERRY_PICK_HEAD', 'cherry-picking'],
  ['REVERT_HEAD', 'reverting'],
  ['BISECT_LOG', 'bisecting'],
]

/** The branch out of a HEAD file, or a short SHA when the head is detached. */
export function branchOf(head: string): { name: string; isDetached: boolean } | null {
  const line = head.trim()
  if (line === '') return null
  const ref = REF.exec(line)
  if (ref !== null) return { name: (ref[1] as string).trim(), isDetached: false }
  // A bare SHA is a detached head, which is worth saying in itself.
  if (/^[0-9a-f]{7,40}$/i.test(line)) return { name: line.slice(0, 7), isDetached: true }
  return null
}

/** Where the real git directory is, given what `.git` contained. */
export function gitDirOf(root: string, dotGit: string | null): string {
  const found = dotGit === null ? null : GITDIR.exec(dotGit.trim())
  // A worktree's `.git` is a file pointing elsewhere; otherwise it is the dir.
  return found === null ? `${root}/.git` : (found[1] as string).trim()
}

export function isProtected(name: string): boolean {
  return PROTECTED.test(name)
}

/**
 * Reads the repository. Called on a timer and when the directory changes, not
 * while drawing: a render may do no I/O.
 */
export async function readRepo($: EngineInterface): Promise<Repo | null> {
  let root: string
  try {
    const repo = await $.session.repo()
    if (repo === null) return null
    root = String(repo.root)
  } catch {
    return null
  }

  // A linked worktree's `.git` is a file naming the real directory. Reading it
  // is how this works in a worktree at all, and it is the common case for a
  // session the app started for a task.
  let dir = `${root}/.git`
  try {
    const text = String(await $.fs.read(`${root}/.git`, { as: 'text' }))
    dir = gitDirOf(root, text)
  } catch {
    // A directory rather than a file, which is the ordinary case.
  }

  let head: { name: string; isDetached: boolean } | null = null
  try {
    head = branchOf(String(await $.fs.read(`${dir}/HEAD`, { as: 'text' })))
  } catch {
    return null
  }
  if (head === null) return null

  let midway: string | null = null
  for (const [file, word] of MIDWAY) {
    try {
      if (await $.fs.exists(`${dir}/${file}`)) {
        midway = word
        break
      }
    } catch {
      // A path that cannot be asked about is not an operation in progress.
    }
  }

  // Equal refs or not. A count would need the commit graph, which is not
  // reachable from here, so nothing claims one.
  let sync: Repo['sync'] = 'unknown'
  if (!head.isDetached) {
    try {
      const mine = String(await $.fs.read(`${dir}/refs/heads/${head.name}`, { as: 'text' })).trim()
      const theirs = String(
        await $.fs.read(`${dir}/refs/remotes/origin/${head.name}`, { as: 'text' }),
      ).trim()
      if (mine !== '' && theirs !== '') sync = mine === theirs ? 'synced' : 'diverged'
    } catch {
      // Packed refs, no upstream, a fresh branch: all simply unknown.
    }
  }

  return { branch: head.name, isDetached: head.isDetached, isProtected: isProtected(head.name), midway, sync }
}

/** How often the repository is re-read when nothing says it changed. */
export const REPO_MS = 30_000

/** Called from the mod's one session.start hook in boot.ts. */
export async function startGit($: EngineInterface): Promise<void> {
  const look = async (): Promise<void> => {
    const repo = await readRepo($)
    await writeShape($, prev => ({ ...prev, repo }))
  }
  await look()
  $.clock.every(REPO_MS, () => {
    void look()
  })
}
