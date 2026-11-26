// The plugin's own worker: the only part that talks to TickTick (panel frames have no network).
// Orca starts it on the panel's first plugin.request and transpiles this file when it loads.
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  AuthStatus,
  TaskDraft,
  TaskPatch,
  TaskRef,
  TickData,
  TickProject,
  TickTask
} from './protocol'

const API = 'https://api.ticktick.com/open/v1'
const TOKEN_KEY = 'ticktick.token'
/** Repeated panel opens inside this window reuse the last load instead of calling TickTick. */
const CACHE_MS = 30_000

type Fail = Error & { code?: string }

function fail(code: string, message: string): Fail {
  const error: Fail = new Error(message)
  error.code = code
  return error
}

/** Where the token lives: the OS keychain when Orca has one, else the plugin's own storage. */
async function useKeychain(orca: OrcaWorkerApi): Promise<boolean> {
  try {
    const { status } = await orca.host.call('secrets.protection')
    return status === 'os-keyring'
  } catch {
    return false
  }
}

async function readToken(orca: OrcaWorkerApi): Promise<string | null> {
  if (await useKeychain(orca)) {
    const value = await orca.secrets.get(TOKEN_KEY)
    if (value) return value
  }
  const stored = await orca.storage.get(TOKEN_KEY)
  return typeof stored === 'string' && stored ? stored : null
}

async function status(orca: OrcaWorkerApi): Promise<AuthStatus> {
  const keychain = await useKeychain(orca)
  if (keychain && (await orca.secrets.get(TOKEN_KEY))) return { connected: true, storedIn: 'keychain' }
  const stored = await orca.storage.get(TOKEN_KEY)
  if (typeof stored === 'string' && stored) return { connected: true, storedIn: 'storage' }
  return { connected: false, storedIn: null }
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (error) {
    throw fail('unavailable', `Cannot reach TickTick: ${(error as Error).message}`)
  }
  if (response.status === 401) throw fail('not_permitted', 'TickTick refused the token (401). Connect again.')
  if (response.status === 429) throw fail('rate_limited', 'TickTick allows 100 calls a minute. Wait a minute, then try again.')
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 200)
    throw fail('action_failed', `TickTick answered ${response.status}${text ? `: ${text}` : ''}`)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

type RawTask = Partial<TickTask> & { id: string; projectId: string; title?: string }

function toTask(raw: RawTask): TickTask {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title ?? '',
    content: raw.content ?? '',
    dueDate: raw.dueDate || null,
    isAllDay: raw.isAllDay ?? false,
    priority: raw.priority ?? 0,
    status: raw.status ?? 0,
    sortOrder: raw.sortOrder ?? 0
  }
}

type ProjectData = { tasks?: RawTask[] } | null

async function loadAll(token: string): Promise<TickData> {
  const raw = await call<{ id: string; name: string; color?: string; closed?: boolean }[]>(token, 'GET', '/project')
  const projects: TickProject[] = raw
    .filter((p) => !p.closed)
    .map((p) => ({ id: p.id, name: p.name, color: p.color ?? null }))
  // One call per project plus one for the Inbox, in parallel.
  const ids = ['inbox', ...projects.map((p) => p.id)]
  const pages = await Promise.all(
    ids.map((id) =>
      call<ProjectData>(token, 'GET', `/project/${id}/data`).catch((error: Fail) => {
        // An empty Inbox can answer an error; a missing list must not hide the others.
        if (id === 'inbox') return null
        throw error
      })
    )
  )
  const tasks = pages
    .flatMap((page) => page?.tasks ?? [])
    .map(toTask)
    .filter((t) => t.status === 0)
  return { projects, tasks, loadedAt: Date.now() }
}

export default function activate(orca: OrcaWorkerApi): void {
  let cache: TickData | null = null

  async function token(): Promise<string> {
    const value = await readToken(orca)
    if (!value) throw fail('not_permitted', 'Not connected to TickTick.')
    return value
  }

  /** Full reload (one call per list), then tells every open panel. */
  async function refresh(): Promise<TickData> {
    cache = await loadAll(await token())
    orca.panels.post('data.changed', cache)
    return cache
  }

  /**
   * After a change, edit the cached lists in place instead of reloading them: TickTick allows
   * 100 calls a minute and a full reload costs one per list, so each tick stays one call.
   */
  function patchCache(change: (tasks: TickTask[]) => TickTask[]): void {
    if (!cache) return
    cache = { ...cache, tasks: change(cache.tasks) }
    orca.panels.post('data.changed', cache)
  }

  function upsert(task: TickTask): void {
    patchCache((tasks) => {
      const rest = tasks.filter((t) => t.id !== task.id)
      return task.status === 0 ? [...rest, task] : rest
    })
  }

  function drop(id: string): void {
    patchCache((tasks) => tasks.filter((t) => t.id !== id))
  }

  orca.panels.handle('auth.status', () => status(orca))

  orca.panels.handle('auth.connect', async ({ token: value }) => {
    const clean = value.trim().replace(/^Bearer\s+/i, '')
    if (!clean) throw fail('invalid_params', 'Paste a token first.')
    // Prove the token works before keeping it.
    await call(clean, 'GET', '/project')
    if (await useKeychain(orca)) {
      await orca.secrets.set(TOKEN_KEY, clean)
      await orca.storage.delete(TOKEN_KEY)
    } else {
      await orca.storage.set(TOKEN_KEY, clean)
    }
    cache = null
    const result = await status(orca)
    orca.panels.post('auth.changed', result)
    orca.log(`connected, token kept in ${result.storedIn}`)
    return result
  })

  orca.panels.handle('auth.disconnect', async () => {
    if (await useKeychain(orca)) await orca.secrets.delete(TOKEN_KEY)
    await orca.storage.delete(TOKEN_KEY)
    cache = null
    const result = await status(orca)
    orca.panels.post('auth.changed', result)
    return result
  })

  orca.panels.handle('data.load', async ({ fresh }) => {
    if (!fresh && cache && Date.now() - cache.loadedAt < CACHE_MS) return cache
    return refresh()
  })

  orca.panels.handle('task.create', async (draft: TaskDraft) => {
    const title = draft.title.trim()
    if (!title) throw fail('invalid_params', 'A task needs a title.')
    const body: Record<string, unknown> = { title, priority: draft.priority ?? 0 }
    if (draft.projectId && draft.projectId !== 'inbox') body.projectId = draft.projectId
    if (draft.dueDate) {
      body.dueDate = draft.dueDate
      body.startDate = draft.dueDate
      body.isAllDay = draft.isAllDay ?? true
      if (draft.timeZone) body.timeZone = draft.timeZone
    }
    const task = toTask(await call<RawTask>(await token(), 'POST', '/task', body))
    upsert(task)
    return { task }
  })

  orca.panels.handle('task.update', async (patch: TaskPatch) => {
    const body: Record<string, unknown> = { id: patch.id, projectId: patch.projectId }
    if (patch.title !== undefined) body.title = patch.title.trim()
    if (patch.content !== undefined) body.content = patch.content
    if (patch.priority !== undefined) body.priority = patch.priority
    if (patch.dueDate !== undefined) {
      // null clears the date (verified live); an empty string is silently ignored.
      body.dueDate = patch.dueDate
      body.startDate = patch.dueDate
      if (patch.dueDate) body.isAllDay = patch.isAllDay ?? true
      if (patch.timeZone) body.timeZone = patch.timeZone
    }
    if (body.title === '') throw fail('invalid_params', 'A task needs a title.')
    const task = toTask(await call<RawTask>(await token(), 'POST', `/task/${patch.id}`, body))
    upsert(task)
    return { task }
  })

  orca.panels.handle('task.complete', async ({ id, projectId }: TaskRef) => {
    await call(await token(), 'POST', `/project/${projectId}/task/${id}/complete`)
    drop(id)
    return { ok: true as const }
  })

  orca.panels.handle('task.reopen', async ({ id, projectId }: TaskRef) => {
    upsert(toTask(await call<RawTask>(await token(), 'POST', `/task/${id}`, { id, projectId, status: 0 })))
    return { ok: true as const }
  })

  orca.panels.handle('task.delete', async ({ id, projectId }: TaskRef) => {
    await call(await token(), 'DELETE', `/project/${projectId}/task/${id}`)
    drop(id)
    return { ok: true as const }
  })
}
