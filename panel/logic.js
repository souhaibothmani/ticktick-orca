// Pure helpers of the panel: dates, ordering, and what the task page sends.
// No DOM and no `orca` here, so `orca plugin test` can run them in Node.

/** @typedef {import('../src/protocol').TickTask} TickTask */
/** @typedef {{ title: string, content: string, due: string, priority: string }} Fields */
/** @typedef {Fields & { taskId: string, base: Fields }} Draft */

export const PRIORITY = {
  0: { label: 'No priority', key: 'none' },
  1: { label: 'Low priority', key: 'low' },
  3: { label: 'Medium priority', key: 'medium' },
  5: { label: 'High priority', key: 'high' }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** Local YYYY-MM-DD of a Date. */
export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function addDays(d, n) {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}

/** TickTick writes offsets as +0000; Date wants +00:00. */
export function parseDue(iso) {
  if (!iso) return null
  const d = new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(d.getTime()) ? null : d
}

/** @param {TickTask} task */
export function dueKey(task) {
  const d = parseDue(task.dueDate)
  return d ? dayKey(d) : ''
}

/** YYYY-MM-DD -> local midnight in TickTick's format, e.g. 2026-11-26T23:00:00+0000. */
export function toTickDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (dayKey(d) !== day.trim()) return null
  return d.toISOString().slice(0, 19) + '+0000'
}

export function shortDate(d) {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * How a due day reads: "Today", "Tomorrow", "Yesterday", a weekday within the week, else "3 Dec".
 * `kind` drives the colour: overdue red, today accent.
 */
export function dueLabel(key, now = new Date()) {
  if (!key) return null
  const today = dayKey(now)
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  let label
  if (key === today) label = 'Today'
  else if (key === dayKey(addDays(now, 1))) label = 'Tomorrow'
  else if (key === dayKey(addDays(now, -1))) label = 'Yesterday'
  else if (key > today && key <= dayKey(addDays(now, 6))) label = date.toLocaleDateString(undefined, { weekday: 'long' })
  else label = shortDate(date)
  const kind = key < today ? 'overdue' : key === today ? 'today' : 'later'
  return { label, kind }
}

/**
 * Open tasks of a list, as TickTick shows them: dated first by date, then the rest; ties by
 * priority, then TickTick's own order.
 * @param {string} list
 * @param {TickTask[]} all
 */
export function tasksOf(list, all) {
  return all
    .filter((t) => t.projectId === list)
    .sort((a, b) => {
      const da = dueKey(a)
      const db = dueKey(b)
      if (da && db && da !== db) return da.localeCompare(db)
      if (da !== db) return da ? -1 : 1
      return b.priority - a.priority || a.sortOrder - b.sortOrder
    })
}

/** @param {TickTask} task @returns {Fields} */
export function fieldsOf(task) {
  return { title: task.title, content: task.content, due: dueKey(task), priority: String(task.priority) }
}

export const FIELDS = ['title', 'content', 'due', 'priority']

/**
 * A field counts as touched when it differs from TickTick's copy; the title ignores end spaces,
 * which TickTick trims.
 * @param {Draft} d
 */
export function touched(d, f) {
  return f === 'title' ? d.title.trim() !== d.base.title : d[f] !== d.base[f]
}

/**
 * The open task took news from TickTick (a save's answer, another panel, a reload): `base`
 * becomes the news, and every field not touched here follows it. Exact equality, not `touched`:
 * "Hello " must not snap to TickTick's trimmed "Hello" while you type.
 * @param {Draft} d
 * @param {TickTask} task
 * @returns {Draft}
 */
export function followTask(d, task) {
  const fresh = fieldsOf(task)
  const next = { ...d, base: fresh }
  for (const f of FIELDS) if (d[f] === d.base[f]) next[f] = fresh[f]
  return next
}

/**
 * The fields touched here, ready to send. A field that cannot be sent yet (empty title, date not
 * finished) is left out on its own, so the others still save; `held` says so. Only changed
 * fields go in: Orca refuses a request with an undefined field.
 * @param {Draft} d
 * @param {TickTask} task
 */
export function patchOf(d, task, zone) {
  const patch = { id: task.id, projectId: task.projectId }
  let held = false
  if (touched(d, 'title')) {
    if (d.title.trim()) patch.title = d.title
    else held = true
  }
  if (touched(d, 'content')) patch.content = d.content
  if (touched(d, 'priority')) patch.priority = Number(d.priority)
  if (touched(d, 'due')) {
    if (d.due.trim() === '') patch.dueDate = null
    else {
      const due = toTickDate(d.due)
      if (due) {
        patch.dueDate = due
        patch.isAllDay = true
        if (zone) patch.timeZone = zone
      } else held = true
    }
  }
  return { patch: Object.keys(patch).length > 2 ? patch : null, held }
}
