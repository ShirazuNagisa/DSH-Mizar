/**
 * The files a turn handed to the operator.
 *
 * The desktop app draws a card under a turn's summary when the model called
 * `present` — "Declare existing files as final deliverables for the user" — with
 * `{files: [{path, description?}]}`. That call is a `tool/call` record, and
 * `session.messages` drops every `tool/call` on purpose (see
 * {@link summaryRecords}): a page carries summaries, not a transcript, and tool
 * traffic is the largest thing in a log. So the phone could never draw those
 * cards, and the operator's only route to a delivered document was to read its
 * name in prose and go find it on the computer.
 *
 * This module reads the calls out of one complete turn's window and hands back
 * the list, which `session.messages` then attaches to that turn's `turn/end`
 * record as `mizarDeliverables`. It is deliberately narrow:
 *
 *   - **Only `present`.** Not "any tool that names a file": `write`, `edit` and
 *     `read` name files constantly, and a card per edited file would turn the
 *     end of every turn into a directory listing. `present` exists precisely to
 *     say "this one is for you".
 *   - **Arguments are a JSON string.** They arrive as text, not an object, and
 *     a truncated or malformed one must not fail the page — the turn still has
 *     an answer to show. A call that cannot be parsed is skipped.
 *   - **Paths stay as the model wrote them.** Relative to the session's working
 *     directory is what the tool's schema says, and resolving them here would
 *     put the host's directory layout on the wire. The reader
 *     (`bridge/files.ts`) resolves and confines them at read time.
 *
 * @module dsh-mizar/bridge/deliverables
 */

/** One file a turn declared as a deliverable. */
export interface DeliveredFile {
  /** The path as the model wrote it: relative to the session's working directory, or absolute. */
  readonly path: string
  /** The one-line description the model wrote for the operator, when it wrote one. */
  readonly description?: string
}

/**
 * How many deliverables one turn may carry.
 *
 * The tool allows at most four files per call and a turn may call it more than
 * once. Eight is what fits under a summary without becoming a list: the phone
 * draws them as cards, and beyond a handful the turn's own prose is the better
 * index.
 */
const MAX_DELIVERABLES = 8

/**
 * The deliverables declared inside one turn's events.
 *
 * Later declarations win: a turn that presents the same report twice (a first
 * draft, then a corrected one) is describing one file, and the description that
 * survives should be the one written last.
 *
 * @param events - one complete turn's events, oldest first, as `turnWindows` builds them.
 * @returns the files, in the order they were presented, at most {@link MAX_DELIVERABLES}.
 */
export function deliverablesOf(events: readonly Record<string, unknown>[]): DeliveredFile[] {
  const byPath = new Map<string, DeliveredFile>()
  for (const event of events) {
    if (event['type'] !== 'tool/call') continue
    const data = event['data']
    if (typeof data !== 'object' || data === null) continue
    if ((data as { name?: unknown }).name !== 'present') continue
    for (const file of presentFiles(data)) {
      const path = cleanPath(file.path)
      if (path === null) continue
      const description = cleanDescription(file.description)
      // Delete first so a re-declaration moves the entry to its latest position
      // rather than keeping the place it was first mentioned in.
      byPath.delete(path)
      byPath.set(path, description === undefined ? { path } : { path, description })
    }
  }
  const files = [...byPath.values()]
  return files.length <= MAX_DELIVERABLES ? files : files.slice(-MAX_DELIVERABLES)
}

/**
 * The `files` array of one `present` call.
 *
 * @param data - the call's `data`.
 * @returns the entries that name a path, ignoring anything else.
 */
function presentFiles(data: object): readonly { path: string; description?: unknown }[] {
  const argumentsText = (data as { arguments?: unknown }).arguments
  let parsed: unknown = argumentsText
  if (typeof argumentsText === 'string') {
    try {
      parsed = JSON.parse(argumentsText)
    } catch {
      // A call whose arguments never finished being written, or that the model
      // wrote as prose. The turn still ends with an answer; it just has no
      // cards, which is what it looked like before this module existed.
      return []
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const files = (parsed as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  const kept: { path: string; description?: unknown }[] = []
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null) continue
    const path = (entry as { path?: unknown }).path
    if (typeof path !== 'string') continue
    kept.push({ path, description: (entry as { description?: unknown }).description })
  }
  return kept
}

/**
 * A path worth sending, or `null`.
 *
 * Surrounding whitespace and a leading `./` are noise a model writes; a path
 * that is empty once those are gone is not a file.
 *
 * @param raw - the path as the model wrote it.
 * @returns the trimmed path, or `null`.
 */
function cleanPath(raw: string): string | null {
  let path = raw.trim()
  while (path.startsWith('./')) path = path.slice(2)
  return path === '' ? null : path
}

/**
 * A description worth showing, or `undefined`.
 *
 * @param raw - the value the model wrote.
 * @returns the trimmed description, or `undefined` when it is not usable text.
 */
function cleanDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text === '' ? undefined : text
}
