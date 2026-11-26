// Runs src/worker.ts's activate(orca) over a mock host, with a fake TickTick behind fetch.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

type Call = { method: string; url: string; body: unknown }

/** A tiny in-memory TickTick: two projects, an Inbox, and the token "good". */
function fakeTickTick(options: { inboxStatus?: number; projectStatus?: number; singleStatus?: number } = {}) {
  const calls: Call[] = []
  const tasks = [
    { id: 't1', projectId: 'p1', title: 'Write plugin', status: 0, priority: 5, sortOrder: 1 },
    { id: 't2', projectId: 'inbox42', title: 'Inbox thing', status: 0, priority: 0, sortOrder: 1 }
  ]
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input).replace('https://api.ticktick.com/open/v1', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const auth = (init?.headers as Record<string, string>)?.Authorization
    if (auth !== 'Bearer good') return new Response('', { status: 401 })
    if (method === 'GET' && url === '/project')
      return json([
        { id: 'p1', name: 'Finikos', color: '#FFAC38' },
        { id: 'p2', name: 'Old', closed: true }
      ])
    const data = /^\/project\/([^/]+)\/data$/.exec(url)
    if (method === 'GET' && data) {
      const id = data[1]
      if (id === 'inbox' && options.inboxStatus) return new Response('', { status: options.inboxStatus })
      if (id !== 'inbox' && options.projectStatus) return new Response('', { status: options.projectStatus })
      return json({ tasks: tasks.filter((t) => (id === 'inbox' ? t.projectId.startsWith('inbox') : t.projectId === id)) })
    }
    if (method === 'POST' && url === '/task') {
      const task = { id: `t${tasks.length + 1}`, projectId: (body as { projectId?: string }).projectId ?? 'inbox42', status: 0, sortOrder: 9, ...(body as object) }
      tasks.push(task as (typeof tasks)[number])
      return json(task)
    }
    const done = /^\/project\/([^/]+)\/task\/([^/]+)\/complete$/.exec(url)
    if (method === 'POST' && done) {
      const t = tasks.find((x) => x.id === done[2])
      if (!t) return new Response('', { status: 404 })
      // As TickTick does: a repeating task keeps its id, stays open, moves to its next date.
      if ((t as { repeatFlag?: string }).repeatFlag) Object.assign(t, { dueDate: '2026-11-28T23:00:00.000+0000' })
      else t.status = 2
      return new Response('', { status: 200 })
    }
    if (method === 'POST' && url === '/task/completed') {
      const ids = (body as { projectIds: string[] }).projectIds
      return json([
        { id: 'd1', projectId: ids[0], title: 'Older', status: 2, completedTime: '2026-11-01T10:00:00.000+0000' },
        { id: 'd2', projectId: ids[0], title: 'Newer', status: 2, completedTime: '2026-11-20T10:00:00.000+0000' }
      ])
    }
    const one = /^\/project\/([^/]+)\/task\/([^/]+)$/.exec(url)
    if (method === 'GET' && one) {
      if (options.singleStatus) return new Response('', { status: options.singleStatus })
      const t = tasks.find((x) => x.id === one[2])
      return t ? json(t) : new Response('', { status: 404 })
    }
    const del = /^\/project\/([^/]+)\/task\/([^/]+)$/.exec(url)
    if (method === 'DELETE' && del) {
      if (!tasks.some((x) => x.id === del[2])) return new Response('', { status: 404 })
      tasks.splice(tasks.findIndex((x) => x.id === del[2]), 1)
      return new Response('', { status: 200 })
    }
    const upd = /^\/task\/([^/]+)$/.exec(url)
    if (method === 'POST' && upd) {
      const t = tasks.find((x) => x.id === upd[1])
      if (!t) return new Response('', { status: 404 })
      Object.assign(t, body)
      return json(t)
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  return { calls, tasks, restore: () => (globalThis.fetch = original) }
}

let restore: (() => void) | null = null
afterEach(() => restore?.())

test('refuses a bad token and stores nothing', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost() })
  await assert.rejects(worker.request('auth.connect', { token: 'bad' }), /401/)
  assert.deepEqual(await worker.request('auth.status'), { connected: false, storedIn: null })
  await assert.rejects(worker.request('data.load', {}), /Not connected/)
  await worker.deactivate()
})

test('connects, loads open tasks, and keeps the token out of plain storage when a keychain exists', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const host = mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } })
  const worker = await mountWorker(main, { host })
  const status = await worker.request('auth.connect', { token: '  Bearer good ' })
  assert.deepEqual(status, { connected: true, storedIn: 'keychain' })
  assert.equal(host.data().secrets['ticktick.token'], 'good')
  assert.equal(host.data().storage['ticktick.token'], undefined)

  const data = await worker.request('data.load', {})
  assert.deepEqual(data.projects, [{ id: 'p1', name: 'Finikos', color: '#FFAC38' }])
  assert.deepEqual(data.tasks.map((t) => t.id).sort(), ['t1', 't2'])
  // Second load inside the cache window: no new call to TickTick.
  const before = api.calls.length
  await worker.request('data.load', {})
  assert.equal(api.calls.length, before)
  await worker.deactivate()
})

test('falls back to plugin storage when there is no keychain', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const host = mockHost({ results: { 'secrets.protection': { status: 'unavailable' } } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('auth.connect', { token: 'good' }), { connected: true, storedIn: 'storage' })
  assert.equal(host.data().storage['ticktick.token'], 'good')
  assert.deepEqual(await worker.request('auth.disconnect'), { connected: false, storedIn: null })
  assert.equal(host.data().storage['ticktick.token'], undefined)
  await worker.deactivate()
})

test('create, update, complete, reopen and delete hit the right endpoints and refresh panels', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const host = mockHost({ storage: { 'ticktick.token': 'good' } })
  const worker = await mountWorker(main, { host })
  await worker.request('data.load', {})
  const loadCalls = api.calls.length

  const created = await worker.request('task.create', {
    title: ' New one ',
    projectId: 'p1',
    dueDate: '2026-11-26T23:00:00+0000',
    timeZone: 'Europe/Rome'
  })
  assert.equal(created.task.title, 'New one')
  const create = api.calls.find((c) => c.method === 'POST' && c.url === '/task')
  assert.deepEqual(create?.body, {
    title: 'New one',
    priority: 0,
    projectId: 'p1',
    dueDate: '2026-11-26T23:00:00+0000',
    startDate: '2026-11-26T23:00:00+0000',
    isAllDay: true,
    timeZone: 'Europe/Rome'
  })

  // An Inbox task is created without projectId.
  await worker.request('task.create', { title: 'Inbox one', projectId: 'inbox' })
  assert.equal((api.calls.filter((c) => c.url === '/task').at(-1)?.body as { projectId?: string }).projectId, undefined)

  await worker.request('task.update', { id: 't1', projectId: 'p1', title: 'Renamed', priority: 3, dueDate: null })
  const update = api.calls.find((c) => c.url === '/task/t1')
  assert.deepEqual(update?.body, { id: 't1', projectId: 'p1', title: 'Renamed', priority: 3, dueDate: null, startDate: null })

  assert.deepEqual(await worker.request('task.complete', { id: 't1', projectId: 'p1' }), { task: null })
  assert.deepEqual(worker.posts.at(-1), { event: 'task.removed', payload: { id: 't1' } })

  const reopened = await worker.request('task.reopen', { id: 't1', projectId: 'p1' })
  assert.equal(reopened.task.status, 0)
  assert.equal(worker.posts.at(-1)?.event, 'task.upserted')

  await worker.request('task.delete', { id: 't2', projectId: 'inbox42' })
  assert.ok(api.calls.some((c) => c.method === 'DELETE' && c.url === '/project/inbox42/task/t2'))
  // Six changes, six calls: no full reload after each one (TickTick allows 100 calls a minute).
  assert.equal(api.calls.length - loadCalls, 6)
  // Small events only: a post is capped at 256 KiB, so the full lists never travel as an event.
  assert.deepEqual(
    worker.posts.map((p) => p.event),
    ['data.reloaded', 'task.upserted', 'task.upserted', 'task.upserted', 'task.removed', 'task.upserted', 'task.removed']
  )
  const cached = await worker.request('data.load', {})
  assert.deepEqual(cached.tasks.map((t) => t.id).sort(), ['t1', 't3', 't4'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('an empty title is refused before calling TickTick', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  await assert.rejects(worker.request('task.create', { title: '   ' }), /needs a title/)
  await assert.rejects(worker.request('task.update', { id: 't1', projectId: 'p1', title: ' ' }), /needs a title/)
  assert.equal(api.calls.length, 0)
  await worker.deactivate()
})

test('a rate limit on the Inbox fails the load instead of hiding Inbox tasks', async () => {
  const api = fakeTickTick({ inboxStatus: 429 })
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  await assert.rejects(worker.request('data.load', {}), /100 calls a minute/)
  await worker.deactivate()
})

test('a missing Inbox still loads the other lists', async () => {
  const api = fakeTickTick({ inboxStatus: 404 })
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  const data = await worker.request('data.load', {})
  assert.deepEqual(data.tasks.map((t) => t.id), ['t1'])
  await worker.deactivate()
})

test('a repeating task is read back after complete and stays open with its next date', async () => {
  const api = fakeTickTick()
  restore = api.restore
  Object.assign(api.tasks[0], { repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', dueDate: '2026-11-27T23:00:00.000+0000' })
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  const answer = await worker.request('task.complete', { id: 't1', projectId: 'p1', repeats: true })
  assert.equal(answer.task?.status, 0)
  assert.equal(answer.task?.dueDate, '2026-11-28T23:00:00.000+0000')
  assert.equal(answer.task?.repeatFlag, 'RRULE:FREQ=DAILY;INTERVAL=1')
  assert.equal(worker.posts.at(-1)?.event, 'task.upserted')
  await worker.deactivate()
})

test('a task gone in TickTick is dropped from the lists and reported as conflict', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  await worker.request('data.load', {})
  api.tasks.splice(0, 1)
  await assert.rejects(worker.request('task.delete', { id: 't1', projectId: 'p1' }), (e: unknown) => (e as { code?: string }).code === 'conflict')
  // A 404 while loading a list is not a conflict: the panel must not reload on it.
  api.tasks.length = 0
  assert.deepEqual(worker.posts.at(-1), { event: 'task.removed', payload: { id: 't1' } })
  assert.ok(!(await worker.request('data.load', {})).tasks.some((t) => t.id === 't1'))
  await worker.deactivate()
})

test('two loads at once share one reload', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  await Promise.all([worker.request('data.load', { fresh: true }), worker.request('data.load', { fresh: true })])
  assert.equal(api.calls.filter((c) => c.url === '/project').length, 1)
  await worker.deactivate()
})

test('a list that answers 404 fails the load as action_failed, not conflict', async () => {
  const api = fakeTickTick({ projectStatus: 404 })
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  await assert.rejects(worker.request('data.load', {}), (e: unknown) => (e as { code?: string }).code === 'action_failed')
  await worker.deactivate()
})

test('a repeating task whose read-back fails is still reported as completed', async () => {
  const api = fakeTickTick({ singleStatus: 429 })
  restore = api.restore
  Object.assign(api.tasks[0], { repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1' })
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  assert.deepEqual(await worker.request('task.complete', { id: 't1', projectId: 'p1', repeats: true }), { task: null })
  assert.deepEqual(worker.posts.at(-1), { event: 'task.removed', payload: { id: 't1' } })
  await worker.deactivate()
})

test('completed tasks of one list: one call, newest first, last 30 days', async () => {
  const api = fakeTickTick()
  restore = api.restore
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'ticktick.token': 'good' } }) })
  const { tasks } = await worker.request('tasks.completed', { projectId: 'p1' })
  assert.deepEqual(tasks.map((t) => t.id), ['d2', 'd1'])
  assert.equal(tasks[0].completedTime, '2026-11-20T10:00:00.000+0000')
  assert.equal(api.calls.length, 1)
  const body = api.calls[0].body as { projectIds: string[]; startDate: string; endDate: string }
  assert.deepEqual(body.projectIds, ['p1'])
  const days = (Date.parse(body.endDate.replace('+0000', 'Z')) - Date.parse(body.startDate.replace('+0000', 'Z'))) / 86_400_000
  assert.equal(Math.round(days), 31)
  await worker.deactivate()
})
