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
  return { id, projectId, title, content: '', dueDate: null, isAllDay: true, priority: 0, status: 0, sortOrder: 0, repeatFlag: null, ...extra }
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
      'task.complete': (input) => {
        sent.push({ name: 'task.complete', input })
        return { task: null }
      },
      'task.reopen': (input) => {
        sent.push({ name: 'task.reopen', input })
        return { task: data.tasks.find((t) => t.id === input.id)! }
      },
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

test('the panel applies answers itself, even when the worker restarted with an empty cache', async () => {
  // The worker answers but posts nothing, as after an idle restart.
  const host = mockHost({
    requests: {
      'auth.status': { connected: true, storedIn: 'keychain' },
      'data.load': () => fixture(),
      'task.create': (input) => ({ task: task('t9', 'p1', input.title) }),
      'task.update': (input: TaskPatch) => ({ task: { ...fixture().tasks.find((t) => t.id === input.id)!, title: input.title ?? '' } }),
      'task.delete': () => ({ ok: true as const })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.type({ label: 'Add task' }, 'Fresh one', { submit: true })
  assert.ok(view.find({ label: 'Fresh one' }), 'created task shows without any event')
  await view.press({ label: 'Open ISTAT' })
  await view.type({ label: 'Title' }, 'ISTAT Q4', { replace: true })
  await view.press({ text: 'Save' })
  assert.equal(view.find({ text: 'Save' })?.disabled, true, 'Save goes quiet once saved')
  await view.press({ text: 'Delete' })
  await view.press({ text: 'Press again to delete' })
  assert.equal(view.find({ label: 'ISTAT Q4' }), null, 'deleted task leaves the list')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('events from the worker keep a second panel in step', async () => {
  const host = mockHost({ requests: { 'auth.status': { connected: true, storedIn: 'keychain' }, 'data.load': () => fixture() } })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.post('task.upserted', { task: task('t7', 'p1', 'From the other panel') })
  assert.ok(view.find({ label: 'From the other panel' }))
  await view.post('task.removed', { id: 't7' })
  assert.equal(view.find({ label: 'From the other panel' }), null)
  await view.unmount()
})

test('a repeating task stays in the list with its next date and offers no Undo', async () => {
  const next = task('t1', 'p1', 'ISTAT', { dueDate: day(1), priority: 5, repeatFlag: 'RRULE:FREQ=DAILY' })
  const host = mockHost({
    requests: {
      'auth.status': { connected: true, storedIn: 'keychain' },
      'data.load': () => {
        const d = fixture()
        d.tasks[0].repeatFlag = 'RRULE:FREQ=DAILY'
        return d
      },
      'task.complete': (input) => {
        assert.equal((input as { repeats?: boolean }).repeats, true)
        return { task: next }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.toggle({ label: 'ISTAT' })
  assert.ok(view.find({ label: 'ISTAT' }), 'still listed')
  assert.equal(view.find({ text: 'Undo' }), null)
  await view.unmount()
})

test('a list that no longer exists shows a way back', async () => {
  const host = mockHost({ requests: { 'auth.status': { connected: true, storedIn: 'keychain' }, 'data.load': () => fixture() } })
  const view = await mount(panel, { host, persisted: { plugin: { nav: { screen: 'tasks', list: 'gone' } } } })
  assert.ok(view.find({ label: 'This list no longer exists' }))
  await view.press({ text: '← Lists' })
  assert.ok(view.find({ label: 'Today' }))
  await view.unmount()
})

test('a failing list load does not reload by itself, and a gone task reloads exactly once', async () => {
  let loads = 0
  let failLoads = false
  const host = mockHost({
    requests: {
      'auth.status': { connected: true, storedIn: 'keychain' },
      'data.load': () => {
        loads += 1
        if (failLoads) throw Object.assign(new Error('TickTick answered 404: not found.'), { code: 'action_failed' })
        return fixture()
      },
      'task.complete': () => {
        throw Object.assign(new Error('This task no longer exists in TickTick.'), { code: 'conflict' })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(loads, 1)
  await view.press({ label: '🧡Finikos' })
  failLoads = true
  await view.toggle({ label: 'ISTAT' })
  await view.settled()
  // One reload after the conflict; its own failure does not start another.
  assert.equal(loads, 2)
  assert.equal(view.find({ label: 'ISTAT' }), null, 'a gone task is not put back')
  assert.ok(view.find({ text: 'This task no longer exists in TickTick.' }), 'the conflict message stays visible')
  await view.unmount()
})

test('a repeating task whose read-back failed leaves the list without Undo', async () => {
  const host = mockHost({
    requests: {
      'auth.status': { connected: true, storedIn: 'keychain' },
      'data.load': () => {
        const d = fixture()
        d.tasks[0].repeatFlag = 'RRULE:FREQ=DAILY'
        return d
      },
      'task.complete': () => ({ task: null })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.toggle({ label: 'ISTAT' })
  assert.equal(view.find({ label: 'ISTAT' }), null)
  assert.equal(view.find({ text: 'Undo' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
