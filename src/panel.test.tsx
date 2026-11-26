// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { TaskPatch, TickData, TickTask } from './protocol'

function day(offset: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 19) + '+0000'
}

function task(id: string, projectId: string, title: string, extra: Partial<TickTask> = {}): TickTask {
  return { id, projectId, title, content: '', dueDate: null, isAllDay: true, priority: 0, status: 0, sortOrder: 0, ...extra }
}

function fixture(): TickData {
  return {
    projects: [
      { id: 'p1', name: '🧡Finikos', color: '#FFAC38' },
      { id: 'p2', name: '🇧🇬VVS Growth', color: '#FFAC38' }
    ],
    tasks: [
      task('t1', 'p1', 'ISTAT', { dueDate: day(0), priority: 5 }),
      task('t2', 'p1', 'Send invoice', { dueDate: day(3) }),
      task('t3', 'p2', 'GDPR check'),
      task('t4', 'inbox42', 'Buy milk', { dueDate: day(-2) })
    ],
    loadedAt: Date.now()
  }
}

test('without a token the panel shows Connect, and a good token opens the lists', async () => {
  let connected = false
  const host = mockHost({
    requests: {
      'auth.status': () => ({ connected, storedIn: connected ? 'keychain' : null }),
      'auth.connect': ({ token }) => {
        if (token !== 'good') throw Object.assign(new Error('TickTick refused the token (401).'), { code: 'action_failed' })
        connected = true
        return { connected: true, storedIn: 'keychain' }
      },
      'data.load': () => fixture()
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connect TickTick' }))
  await view.type({ label: 'Access token' }, 'bad')
  await view.press({ text: 'Connect' })
  assert.ok(view.find({ text: 'TickTick refused the token (401).' }))
  await view.type({ label: 'Access token' }, 'good', { replace: true })
  await view.press({ text: 'Connect' })
  assert.ok(view.find({ label: '🧡Finikos' }), 'lists screen after connect')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('lists -> tasks -> detail -> back, with smart list counts', async () => {
  const host = mockHost({
    requests: { 'auth.status': { connected: true, storedIn: 'keychain' }, 'data.load': () => fixture() }
  })
  const view = await mount(panel, { host })
  // Today = due today + overdue; Next 7 Days adds the one in 3 days; Inbox = inbox tasks.
  assert.ok(view.find({ label: 'Today' }))
  const descriptions = view.findAll({ type: 'ListItem' }).map((e) => e.props.description)
  assert.deepEqual(descriptions.slice(0, 5), ['2 tasks', '3 tasks', '1 tasks', '2 tasks', '1 tasks'])

  await view.press({ label: '🧡Finikos' })
  assert.ok(view.find({ label: 'ISTAT' }))
  assert.ok(view.find({ label: 'Send invoice' }))
  assert.equal(view.find({ label: 'GDPR check' }), null)

  await view.press({ label: 'Open ISTAT' })
  assert.equal(view.valueOf({ label: 'Title' }), 'ISTAT')
  assert.equal(view.valueOf({ label: 'Priority' }), '5')

  await view.press({ text: '← 🧡Finikos' })
  assert.ok(view.find({ label: 'Send invoice' }))
  await view.press({ text: '← Lists' })
  assert.ok(view.find({ label: 'Next 7 Days' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('tick, undo, quick add, edit and delete send the right requests', async () => {
  let data = fixture()
  const sent: { name: string; input: unknown }[] = []
  const log = (name: string) => (input: unknown) => {
    sent.push({ name, input })
    return { ok: true as const }
  }
  const host = mockHost({
    requests: {
      'auth.status': { connected: true, storedIn: 'keychain' },
      'data.load': () => data,
      'task.complete': log('task.complete'),
      'task.reopen': log('task.reopen'),
      'task.delete': log('task.delete'),
      'task.create': (input) => {
        sent.push({ name: 'task.create', input })
        return { task: task('t9', 'inbox42', input.title) }
      },
      'task.update': (input: TaskPatch) => {
        sent.push({ name: 'task.update', input })
        data = { ...data, tasks: data.tasks.map((t) => (t.id === input.id ? { ...t, ...input, dueDate: input.dueDate ?? t.dueDate } as TickTask : t)) }
        return { task: data.tasks.find((t) => t.id === input.id)! }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Today' })

  // Quick add from Today: due today, no project (Inbox).
  await view.type({ label: 'Add task' }, 'Call Filippo', { submit: true })
  const create = sent.find((s) => s.name === 'task.create')?.input as { title: string; projectId?: string; dueDate: string }
  assert.equal(create.title, 'Call Filippo')
  assert.equal(create.projectId, undefined)
  assert.equal(create.dueDate, day(0))
  assert.equal(view.valueOf({ label: 'Add task' }), '', 'field clears after add')

  // Tick: the row goes away and Undo appears.
  await view.toggle({ label: 'ISTAT' })
  assert.deepEqual(sent.find((s) => s.name === 'task.complete')?.input, { id: 't1', projectId: 'p1' })
  assert.equal(view.find({ label: 'ISTAT' }), null)
  await view.press({ text: 'Undo' })
  assert.deepEqual(sent.find((s) => s.name === 'task.reopen')?.input, { id: 't1', projectId: 'p1' })

  // Edit: rename, set priority, clear the date.
  await view.press({ label: 'Open Buy milk' })
  await view.type({ label: 'Title' }, 'Buy oat milk', { replace: true })
  await view.select({ label: 'Priority' }, '3')
  await view.press({ text: 'No date' })
  await view.press({ text: 'Save' })
  assert.deepEqual(sent.find((s) => s.name === 'task.update')?.input, {
    id: 't4',
    projectId: 'inbox42',
    title: 'Buy oat milk',
    priority: 3,
    dueDate: null
  })

  // A bad date is refused in the panel, not sent.
  const updates = sent.filter((s) => s.name === 'task.update').length
  await view.type({ label: 'Due date' }, '2026-13-40', { replace: true })
  await view.press({ text: 'Save' })
  assert.equal(sent.filter((s) => s.name === 'task.update').length, updates)
  assert.ok(view.find({ text: /YYYY-MM-DD/ }))

  // Delete asks twice.
  await view.press({ text: 'Delete' })
  assert.equal(sent.some((s) => s.name === 'task.delete'), false)
  await view.press({ text: 'Press again to delete' })
  assert.deepEqual(sent.find((s) => s.name === 'task.delete')?.input, { id: 't4', projectId: 'inbox42' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a refused token mid-session sends you back to Connect', async () => {
  const host = mockHost({
    requests: {
      'auth.status': { connected: true, storedIn: 'keychain' },
      'data.load': () => {
        throw Object.assign(new Error('TickTick refused the token (401). Connect again.'), { code: 'not_permitted' })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connect TickTick' }))
  assert.ok(view.find({ text: /Connect again/ }))
  await view.unmount()
})
