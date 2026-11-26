// The panel's pure logic (panel/logic.js), run in Node by `orca plugin test .`.
import { assert, test } from 'orca/testing'
import * as L from '../panel/logic.js'
import type { TickTask } from './protocol'

function task(extra: Partial<TickTask> = {}): TickTask {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'ISTAT',
    content: 'notes',
    dueDate: null,
    isAllDay: true,
    priority: 0,
    status: 0,
    sortOrder: 0,
    repeatFlag: null,
    completedTime: null,
    ...extra
  }
}

function midnight(offset: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 19) + '+0000'
}

test('dates: TickTick format in and out, local day kept', () => {
  const due = L.toTickDate('2026-12-01')
  assert.equal(due, new Date(2026, 11, 1).toISOString().slice(0, 19) + '+0000')
  assert.equal(L.dueKey(task({ dueDate: due })), '2026-12-01')
  assert.equal(L.toTickDate('2026-13-40'), null)
  assert.equal(L.toTickDate('2026-02-30'), null)
  assert.equal(L.parseDue(null), null)
})

test('due labels and their colour', () => {
  const now = new Date(2026, 10, 26, 15)
  assert.deepEqual(L.dueLabel('2026-11-26', now), { label: 'Today', kind: 'today' })
  assert.deepEqual(L.dueLabel('2026-11-27', now), { label: 'Tomorrow', kind: 'later' })
  assert.deepEqual(L.dueLabel('2026-11-25', now), { label: 'Yesterday', kind: 'overdue' })
  assert.equal(L.dueLabel('2026-11-10', now)?.kind, 'overdue')
  assert.equal(L.dueLabel('', now), null)
})

test('tasks of a list: dated first by date, then priority, then TickTick order', () => {
  const all = [
    task({ id: 'a', sortOrder: 2 }),
    task({ id: 'b', dueDate: midnight(3) }),
    task({ id: 'c', dueDate: midnight(-1) }),
    task({ id: 'd', priority: 5, sortOrder: 9 }),
    task({ id: 'x', projectId: 'p2' })
  ]
  assert.deepEqual(L.tasksOf('p1', all).map((t: TickTask) => t.id), ['c', 'b', 'd', 'a'])
})

test('patchOf sends only touched fields, and holds back a bad one alone', () => {
  const t = task({ priority: 3 })
  const base = L.fieldsOf(t)
  const d = { ...base, taskId: 't1', base }
  assert.deepEqual(L.patchOf(d, t, 'Europe/Rome'), { patch: null, held: false })
  assert.deepEqual(L.patchOf({ ...d, content: 'more' }, t, 'Europe/Rome'), {
    patch: { id: 't1', projectId: 'p1', content: 'more' },
    held: false
  })
  // Empty title held, description still goes.
  assert.deepEqual(L.patchOf({ ...d, title: ' ', content: 'x' }, t, 'Europe/Rome'), {
    patch: { id: 't1', projectId: 'p1', content: 'x' },
    held: true
  })
  // Unfinished date held; a cleared date is null; a full date carries zone and all-day.
  assert.equal(L.patchOf({ ...d, due: '2026-1' }, t, 'Europe/Rome').held, true)
  assert.deepEqual(L.patchOf({ ...d, due: '' , base: { ...base, due: '2026-12-01' } }, t, 'Europe/Rome').patch, {
    id: 't1',
    projectId: 'p1',
    dueDate: null
  })
  assert.deepEqual(L.patchOf({ ...d, due: '2026-12-01' }, t, 'Europe/Rome').patch, {
    id: 't1',
    projectId: 'p1',
    dueDate: L.toTickDate('2026-12-01'),
    isAllDay: true,
    timeZone: 'Europe/Rome'
  })
  // A title with an end space is not "touched" once TickTick has the trimmed one.
  assert.equal(L.patchOf({ ...d, title: 'ISTAT ' }, t, 'Europe/Rome').patch, null)
})

test('followTask: news from elsewhere reaches untouched fields only, and keeps an end space', () => {
  const t = task()
  const base = L.fieldsOf(t)
  const typing = { ...base, taskId: 't1', base, content: 'typed here', title: 'Hello ' }
  const elsewhere = task({ priority: 1, content: 'changed elsewhere', title: 'Hello' })
  const next = L.followTask(typing, elsewhere)
  assert.equal(next.priority, '1', 'untouched priority follows')
  assert.equal(next.content, 'typed here', 'touched description stays')
  assert.equal(next.title, 'Hello ', 'the space is not trimmed away')
  assert.deepEqual(next.base, L.fieldsOf(elsewhere))
  // Then only the description is sent: the priority set elsewhere is not overwritten.
  assert.deepEqual(L.patchOf(next, elsewhere, 'Europe/Rome').patch, { id: 't1', projectId: 'p1', content: 'typed here' })
})
