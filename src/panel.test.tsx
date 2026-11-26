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
  return {
    id,
    projectId,
    title,
    content: '',
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

function fixture(): TickData {
  return {
    projects: [
      { id: 'p1', name: '🧡Finikos', color: '#FFAC38' },
      { id: 'p2', name: '🇧🇬VVS Growth', color: '#FFAC38' }
    ],
    tasks: [
      task('t1', 'p1', 'ISTAT', { dueDate: day(0), priority: 5, content: '## Steps\n- check the **numbers**' }),
      task('t2', 'p1', 'Send invoice', { dueDate: day(-2) }),
      task('t3', 'p2', 'GDPR check')
    ],
    loadedAt: Date.now()
  }
}

const connected = { 'auth.status': { connected: true, storedIn: 'keychain' as const } }

function clean(view: { errors: readonly unknown[]; refusals: readonly unknown[]; warnings: readonly string[] }) {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
}

test('without a token the panel shows Connect, and a good token opens the lists', async () => {
  let ok = false
  const host = mockHost({
    requests: {
      'auth.status': () => ({ connected: ok, storedIn: ok ? 'keychain' : null }),
      'auth.connect': ({ token }) => {
        if (token !== 'good') throw Object.assign(new Error('TickTick refused the token (401).'), { code: 'action_failed' })
        ok = true
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
  clean(view)
  await view.unmount()
})

test('lists show only projects, with open and overdue counts, and Disconnect sits in the footer', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { ...connected, 'data.load': () => fixture() } }) })
  assert.equal(view.find({ label: 'Today' }), null)
  assert.equal(view.find({ label: 'Inbox' }), null)
  const items = view.findAll({ type: 'ListItem' }).map((e) => [e.label, e.props.description])
  assert.deepEqual(items, [
    ['🧡Finikos', '2 open · 1 overdue'],
    ['🇧🇬VVS Growth', '1 open']
  ])
  // The footer is the last child of the page column, outside the scrolling area.
  const tree = view.tree() as { type: string; props: Record<string, unknown>; children: { props?: Record<string, unknown> }[] }
  assert.equal(tree.type, 'Box')
  assert.equal(tree.props.height, '100%')
  assert.equal(tree.children[0].props?.scroll, 'y')
  assert.ok(view.find({ text: 'Disconnect' }))
  clean(view)
  await view.unmount()
})

test('pressing a title opens the task; it never ticks it', async () => {
  const sent: string[] = []
  const host = mockHost({
    requests: {
      ...connected,
      'data.load': () => fixture(),
      'task.complete': () => {
        sent.push('complete')
        return { task: null }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.press({ type: 'ListItem', label: 'ISTAT' })
  assert.deepEqual(sent, [])
  assert.ok(view.find({ type: 'Heading', text: 'ISTAT' }))
  assert.ok(view.find({ type: 'Markdown' }), 'description shown as Markdown')
  assert.ok(view.find({ type: 'Badge', text: 'Today' }))
  assert.ok(view.find({ type: 'Badge', text: 'High priority' }))
  await view.press({ text: '← 🧡Finikos' })
  assert.ok(view.find({ label: 'Send invoice' }))
  clean(view)
  await view.unmount()
})

test('the tick asks first: Cancel keeps the task, Complete completes it', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: {
      ...connected,
      'data.load': () => fixture(),
      'task.complete': (input) => {
        sent.push(input)
        return { task: null }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.press({ label: 'Complete ISTAT' })
  assert.ok(view.find({ text: 'Complete “ISTAT”?' }))
  await view.press({ text: 'Cancel' })
  assert.deepEqual(sent, [])
  assert.ok(view.find({ type: 'ListItem', label: 'ISTAT' }))

  await view.press({ label: 'Complete ISTAT' })
  await view.press({ type: 'Button', text: 'Complete' })
  assert.deepEqual(sent, [{ id: 't1', projectId: 'p1' }])
  assert.equal(view.find({ type: 'ListItem', label: 'ISTAT' }), null)
  clean(view)
  await view.unmount()
})

test('Completed is closed, loads when opened, and unticking brings the task back', async () => {
  let loads = 0
  const finished = task('t9', 'p1', 'Old invoice', { status: 2, completedTime: '2026-11-20T10:00:00.000+0000' })
  const host = mockHost({
    requests: {
      ...connected,
      'data.load': () => fixture(),
      'tasks.completed': ({ projectId }) => {
        loads += 1
        assert.equal(projectId, 'p1')
        return { tasks: [finished] }
      },
      'task.reopen': (input) => ({ task: { ...finished, id: input.id, status: 0, completedTime: null } })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  assert.equal(view.valueOf({ type: 'Collapsible' }), false)
  assert.equal(loads, 0, 'nothing loaded while closed')
  await view.toggle({ type: 'Collapsible' })
  assert.equal(loads, 1)
  assert.ok(view.find({ type: 'Collapsible', label: 'Completed · 1' }))
  await view.press({ label: 'Untick Old invoice' })
  assert.ok(view.find({ type: 'ListItem', label: 'Old invoice' }), 'back with the open tasks')
  assert.ok(view.find({ type: 'Collapsible', label: 'Completed · 0' }))
  clean(view)
  await view.unmount()
})

test('a task completed here goes into an open Completed section', async () => {
  const host = mockHost({
    requests: {
      ...connected,
      'data.load': () => fixture(),
      'tasks.completed': () => ({ tasks: [] }),
      'task.complete': () => ({ task: null })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })
  await view.toggle({ type: 'Collapsible' })
  await view.press({ label: 'Complete ISTAT' })
  await view.press({ type: 'Button', text: 'Complete' })
  assert.ok(view.find({ type: 'Collapsible', label: 'Completed · 1' }))
  assert.ok(view.find({ label: 'Untick ISTAT' }))
  clean(view)
  await view.unmount()
})

test('quick add, edit and delete (with confirmation) send the right requests', async () => {
  let data = fixture()
  const sent: { name: string; input: unknown }[] = []
  const host = mockHost({
    requests: {
      ...connected,
      'data.load': () => data,
      'task.create': (input) => {
        sent.push({ name: 'task.create', input })
        return { task: task('t8', 'p1', input.title) }
      },
      'task.update': (input: TaskPatch) => {
        sent.push({ name: 'task.update', input })
        const t = data.tasks.find((x) => x.id === input.id)!
        const next = { ...t, ...input, dueDate: input.dueDate === undefined ? t.dueDate : input.dueDate } as TickTask
        data = { ...data, tasks: data.tasks.map((x) => (x.id === input.id ? next : x)) }
        return { task: next }
      },
      'task.delete': (input) => {
        sent.push({ name: 'task.delete', input })
        return { ok: true as const }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: '🧡Finikos' })

  await view.type({ label: 'Add task' }, 'Call Filippo', { submit: true })
  assert.deepEqual(sent.at(-1), { name: 'task.create', input: { title: 'Call Filippo', projectId: 'p1' } })
  assert.equal(view.valueOf({ label: 'Add task' }), '')
  assert.ok(view.find({ type: 'ListItem', label: 'Call Filippo' }))

  await view.press({ type: 'ListItem', label: 'Send invoice' })
  await view.press({ text: 'Edit' })
  await view.type({ label: 'Title' }, 'Send Q4 invoice', { replace: true })
  await view.type({ label: 'Description' }, 'to **Fabio**')
  await view.select({ label: 'Priority' }, '3')
  await view.press({ text: 'No date' })
  await view.press({ text: 'Save' })
  assert.deepEqual(sent.at(-1), {
    name: 'task.update',
    input: { id: 't2', projectId: 'p1', title: 'Send Q4 invoice', content: 'to **Fabio**', priority: 3, dueDate: null }
  })
  assert.ok(view.find({ type: 'Heading', text: 'Send Q4 invoice' }), 'back to the view after Save')
  assert.ok(view.find({ type: 'Badge', text: 'No date' }))

  // A bad date is refused in the panel, not sent.
  await view.press({ text: 'Edit' })
  const before = sent.length
  await view.type({ label: 'Due date' }, '2026-13-40', { replace: true })
  await view.press({ text: 'Save' })
  assert.equal(sent.length, before)
  assert.ok(view.find({ text: /YYYY-MM-DD/ }))
  await view.press({ text: 'Cancel' })

  await view.press({ label: 'Delete' })
  assert.ok(view.find({ type: 'Callout', label: 'Delete this task?' }))
  assert.equal(sent.length, before, 'nothing deleted yet')
  await view.press({ type: 'Button', text: 'Delete' })
  assert.deepEqual(sent.at(-1), { name: 'task.delete', input: { id: 't2', projectId: 'p1' } })
  assert.equal(view.find({ type: 'ListItem', label: 'Send Q4 invoice' }), null)
  await view.unmount()
})

test('a refused token mid-session sends you back to Connect', async () => {
  const host = mockHost({
    requests: {
      ...connected,
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

test('events from the worker keep a second panel in step', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { ...connected, 'data.load': () => fixture() } }) })
  await view.press({ label: '🧡Finikos' })
  await view.post('task.upserted', { task: task('t7', 'p1', 'From the other panel') })
  assert.ok(view.find({ type: 'ListItem', label: 'From the other panel' }))
  await view.post('task.removed', { id: 't7' })
  assert.equal(view.find({ type: 'ListItem', label: 'From the other panel' }), null)
  await view.unmount()
})

test('a repeating task stays in the list with its next date', async () => {
  const next = task('t1', 'p1', 'ISTAT', { dueDate: day(1), priority: 5, repeatFlag: 'RRULE:FREQ=DAILY' })
  const host = mockHost({
    requests: {
      ...connected,
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
  await view.press({ label: 'Complete ISTAT' })
  await view.press({ type: 'Button', text: 'Complete' })
  const row = view.find({ type: 'ListItem', label: 'ISTAT' })
  assert.equal(row?.props.description, 'Tomorrow · High priority')
  await view.unmount()
})

test('a gone task reloads exactly once, and a failing reload does not loop', async () => {
  let loads = 0
  let failLoads = false
  const host = mockHost({
    requests: {
      ...connected,
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
  await view.press({ label: '🧡Finikos' })
  failLoads = true
  await view.press({ label: 'Complete ISTAT' })
  await view.press({ type: 'Button', text: 'Complete' })
  // The reload starts on the next timer tick; give it time, then make sure no second one follows.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    await view.settled()
  }
  assert.equal(loads, 2)
  assert.equal(view.find({ type: 'ListItem', label: 'ISTAT' }), null, 'a gone task is not put back')
  assert.ok(view.find({ text: 'This task no longer exists in TickTick.' }))
  await view.unmount()
})

test('a list that no longer exists shows a way back', async () => {
  const host = mockHost({ requests: { ...connected, 'data.load': () => fixture() } })
  const view = await mount(panel, { host, persisted: { plugin: { nav: { screen: 'tasks', list: 'gone' } } } })
  assert.ok(view.find({ label: 'This list no longer exists' }))
  await view.press({ text: '← Lists' })
  assert.ok(view.find({ label: '🧡Finikos' }))
  await view.unmount()
})
