import type { EngineInterface } from 'claude-code'

import { writeEdits } from './state'

import type { Edits } from '../../types'

/**
 * What this session has changed, counted from the calls that changed it.
 *
 * This is deliberately **not** `git status`, and the difference matters enough
 * that the band says `session edits` rather than anything suggesting a working
 * tree. It counts what Tower watched happen: it cannot see a change you made
 * in your editor, and it will not un-count a file you reverted afterwards. As
 * an answer to "is it time to commit" that is honest and nearly free; as an
 * answer to "what is dirty" it would be wrong, and the only thing stopping
 * someone reading it the second way is what it is called.
 *
 * The alternative is walking the worktree on a timer, which is the kind of
 * cost a band should never impose on a repository it did not choose.
 */

/** Tools that change a file on disk, and where each keeps its text. */
const WRITERS: Readonly<Record<string, 'edit' | 'write'>> = {
  Edit: 'edit',
  Write: 'write',
  NotebookEdit: 'edit',
}

export function isWriter(tool: string): boolean {
  return tool in WRITERS
}

function lines(text: string): number {
  if (text === '') return 0
  return text.split('\n').length
}

/** The file and line change one call represents, or null when it is not one. */
export function changeOf(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): { path: string; added: number; removed: number } | null {
  const kind = WRITERS[tool]
  if (kind === undefined) return null
  const path = typeof input['file_path'] === 'string' ? input['file_path'] : ''
  if (path === '') return null

  if (kind === 'write') {
    const body = typeof input['content'] === 'string' ? input['content'] : ''
    return { path, added: lines(body), removed: 0 }
  }

  const before = typeof input['old_string'] === 'string' ? input['old_string'] : ''
  const after = typeof input['new_string'] === 'string' ? input['new_string'] : ''
  // A replace_all rewrites every occurrence, and nothing in the call says how
  // many there are, so one is the only figure that can be claimed.
  return { path, added: lines(after), removed: lines(before) }
}

/** How many lines of an edit are worth keeping to show. */
const HUNK_MAX = 14

/**
 * The last edit as a unified-diff hunk, for `Code` to colour with the engine's
 * own highlighter.
 *
 * Only the most recent one is kept. A real diff of the session would mean
 * holding every edit's before and after in session state, which grows without
 * bound in exactly the sessions that edit most; and the useful question at a
 * glance is "what did it just change", not "what has it changed all day".
 *
 * `@@` carries no line numbers because nothing in the call says where in the
 * file the text sat. A fabricated range would be worse than an honest `@@`.
 */
export function hunkOf(path: string, before: string, after: string): string {
  const name = path.replace(/^.*[\\/]/, '')
  const cut = (text: string, mark: string): string[] =>
    text === '' ? [] : text.split('\n').slice(0, HUNK_MAX).map(l => mark + l)
  const trimmed = before.split('\n').length > HUNK_MAX || after.split('\n').length > HUNK_MAX
  return [
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@',
    ...cut(before, '-'),
    ...cut(after, '+'),
    ...(trimmed ? ['\\ truncated'] : []),
  ].join('\n')
}

/** The fold, pure so the arithmetic can be tested without an engine. */
export function fold(prev: Edits, change: { path: string; added: number; removed: number }): Edits {
  const files = prev.files.includes(change.path) ? prev.files : [...prev.files, change.path]
  return {
    files,
    added: prev.added + change.added,
    removed: prev.removed + change.removed,
  }
}

/**
 * Records one change. Called from the mod's one tool.call hook in tools.ts,
 * after the call resolves — a call that failed changed nothing.
 */
export async function noteEdit(
  $: EngineInterface,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<void> {
  const change = changeOf(tool, input)
  if (change === null) return
  const before = typeof input['old_string'] === 'string' ? input['old_string'] : ''
  const after =
    typeof input['new_string'] === 'string'
      ? input['new_string']
      : typeof input['content'] === 'string'
        ? input['content']
        : ''
  const last = after === '' && before === '' ? undefined : hunkOf(change.path, before, after)
  await writeEdits($, prev => ({ ...fold(prev, change), last }))
}
