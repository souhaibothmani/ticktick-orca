// No build step: Orca strips the types and compiles the JSX when the panel loads.
// Four screens, one at a time: Connect -> Lists -> Tasks -> Task detail, with a back arrow.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  derived,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import type { AuthStatus, TaskDraft, TaskPatch, TickData, TickTask } from './protocol'

// ---------- state ----------

type Nav = { screen: 'lists' } | { screen: 'tasks'; list: string } | { screen: 'task'; list: string; taskId: string }

const auth = atom<AuthStatus | null>(null)
const data = atom<TickData | null>(null)
/** Kept across panel runs, so the panel reopens where you left it. */
const nav = atom<Nav>('nav', { screen: 'lists' }, { persist: 'plugin' })
/** Worker calls in flight; the controls wait while any runs. */
const pending = atom(0)
const busy = derived(() => read(pending) > 0)
const error = atom<string | null>(null)
const tokenDraft = atom('')
const newTitle = atom('')
/** The last task ticked, for the Undo bar. */
const lastDone = atom<TickTask | null>(null)
/** Detail screen edits, saved with the Save button. */
const draft = atom<{ title: string; content: string; due: string; priority: string } | null>(null)
/** Delete asks twice: the first press arms it. */
const deleteArmed = atom(false)

// ---------- dates ----------

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local YYYY-MM-DD of a Date. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}

/** TickTick writes offsets as +0000; Date wants +00:00. */
function parseDue(iso: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(d.getTime()) ? null : d
}

/** YYYY-MM-DD -> local midnight in TickTick's format, e.g. 2026-11-26T23:00:00+0000. */
function toTickDate(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (dayKey(d) !== day.trim()) return null
  return d.toISOString().slice(0, 19) + '+0000'
}

function dueLabel(task: TickTask): string | null {
  const d = parseDue(task.dueDate)
  if (!d) return null
  const today = dayKey(new Date())
  const key = dayKey(d)
  if (key === today) return 'Today'
  if (key === dayKey(addDays(new Date(), 1))) return 'Tomorrow'
  if (key < today) return `Overdue · ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

// ---------- lists ----------

const PRIORITY: Record<number, string> = { 0: 'None', 1: 'Low', 3: 'Medium', 5: 'High' }

const SMART = [
  { id: 'today', name: 'Today', icon: 'calendar' as const },
  { id: 'next7', name: 'Next 7 Days', icon: 'calendar' as const },
  { id: 'inbox', name: 'Inbox', icon: 'folder' as const }
]

function isInbox(task: TickTask): boolean {
  return task.projectId.startsWith('inbox')
}

function tasksOf(list: string, all: TickTask[]): TickTask[] {
  const today = dayKey(new Date())
  const week = dayKey(addDays(new Date(), 6))
  const due = (t: TickTask) => {
    const d = parseDue(t.dueDate)
    return d ? dayKey(d) : null
  }
  let picked: TickTask[]
  if (list === 'today') picked = all.filter((t) => (due(t) ?? '9') <= today)
  else if (list === 'next7') picked = all.filter((t) => (due(t) ?? '9') <= week)
  else if (list === 'inbox') picked = all.filter(isInbox)
  else picked = all.filter((t) => t.projectId === list)
  if (list === 'today' || list === 'next7') {
    return [...picked].sort((a, b) => (due(a) ?? '').localeCompare(due(b) ?? '') || b.priority - a.priority)
  }
  return [...picked].sort((a, b) => a.sortOrder - b.sortOrder)
}

function listName(list: string, d: TickData | null): string {
  return SMART.find((s) => s.id === list)?.name ?? d?.projects.find((p) => p.id === list)?.name ?? 'Tasks'
}

/** New tasks from a smart list: Today/Next 7 Days get today's date, both land in the Inbox. */
function createTarget(list: string): { projectId?: string; due?: string } {
  if (list === 'today' || list === 'next7') return { due: dayKey(new Date()) }
  if (list === 'inbox') return {}
  return { projectId: list }
}

const currentTask = derived(() => {
  const n = read(nav)
  if (n.screen !== 'task') return null
  return read(data)?.tasks.find((t) => t.id === n.taskId) ?? null
})

// ---------- actions ----------

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Applies a task the worker answered or announced: in the lists if open, out if done. */
function applyTask(task: TickTask): void {
  const d = read(data)
  if (!d) return
  const rest = d.tasks.filter((t) => t.id !== task.id)
  set(data, { ...d, tasks: task.status === 0 ? [...rest, task] : rest })
}

function applyRemoved(id: string): void {
  const d = read(data)
  if (d && d.tasks.some((t) => t.id === id)) set(data, { ...d, tasks: d.tasks.filter((t) => t.id !== id) })
}

/** Runs a worker call with the spinner and error bar; a refused token sends you to Connect. */
async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
  update(pending, (n) => n + 1)
  set(error, null)
  let stale = false
  try {
    return await work()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'not_permitted') set(auth, { connected: false, storedIn: null })
    // The task changed in TickTick meanwhile (completed, moved or deleted there): reload once.
    if (code === 'conflict') stale = true
    set(error, message(e))
    return undefined
  } finally {
    update(pending, (n) => n - 1)
    if (stale) void load(true)
  }
}

async function load(fresh = false): Promise<void> {
  const answer = await run(() => plugin.request('data.load', { fresh }))
  if (answer) set(data, answer)
}

async function connect(): Promise<void> {
  const answer = await run(() => plugin.request('auth.connect', { token: read(tokenDraft) }))
  if (!answer) return
  set(tokenDraft, '')
  set(auth, answer)
  set(nav, { screen: 'lists' })
  await load(true)
}

async function disconnect(): Promise<void> {
  const answer = await run(() => plugin.request('auth.disconnect'))
  if (!answer) return
  set(auth, answer)
  set(data, null)
}

async function addTask(list: string, title: string): Promise<boolean> {
  if (!title.trim()) return false
  const target = createTarget(list)
  // Orca refuses a request with an undefined field: add only the fields that have a value.
  const input: TaskDraft = { title }
  if (target.projectId) input.projectId = target.projectId
  const due = target.due ? toTickDate(target.due) : null
  if (due) Object.assign(input, { dueDate: due, isAllDay: true, timeZone: ZONE })
  const answer = await run(() => plugin.request('task.create', input))
  if (answer) applyTask(answer.task)
  return answer !== undefined
}

async function complete(task: TickTask): Promise<void> {
  // Optimistic: the row goes away now.
  applyRemoved(task.id)
  set(lastDone, null)
  const ref = task.repeatFlag
    ? { id: task.id, projectId: task.projectId, repeats: true }
    : { id: task.id, projectId: task.projectId }
  const answer = await run(() => plugin.request('task.complete', ref))
  if (!answer) {
    // Put back only this row: anything else that changed meanwhile stays.
    if (!read(data)?.tasks.some((t) => t.id === task.id)) applyTask(task)
    return
  }
  // A repeating task comes back with its next date, and there is nothing to undo.
  if (answer.task) applyTask(answer.task)
  else set(lastDone, task)
}

async function undo(): Promise<void> {
  const task = read(lastDone)
  if (!task) return
  set(lastDone, null)
  const answer = await run(() => plugin.request('task.reopen', { id: task.id, projectId: task.projectId }))
  if (answer) applyTask(answer.task)
}

function openTask(list: string, task: TickTask): void {
  set(draft, {
    title: task.title,
    content: task.content,
    due: (() => {
      const d = parseDue(task.dueDate)
      return d ? dayKey(d) : ''
    })(),
    priority: String(task.priority)
  })
  set(deleteArmed, false)
  set(nav, { screen: 'task', list, taskId: task.id })
}

async function save(task: TickTask): Promise<void> {
  const d = read(draft)
  if (!d) return
  const patch: TaskPatch = { id: task.id, projectId: task.projectId }
  if (d.title !== task.title) patch.title = d.title
  if (d.content !== task.content) patch.content = d.content
  if (Number(d.priority) !== task.priority) patch.priority = Number(d.priority)
  const oldDue = parseDue(task.dueDate)
  if (d.due !== (oldDue ? dayKey(oldDue) : '')) {
    if (d.due.trim() === '') patch.dueDate = null
    else {
      const due = toTickDate(d.due)
      if (!due) {
        set(error, 'Write the date as YYYY-MM-DD, for example 2026-12-01.')
        return
      }
      patch.dueDate = due
      patch.isAllDay = true
      patch.timeZone = ZONE
    }
  }
  if (Object.keys(patch).length === 2) return
  const answer = await run(() => plugin.request('task.update', patch))
  if (answer) applyTask(answer.task)
}

async function remove(list: string, task: TickTask): Promise<void> {
  if (!read(deleteArmed)) {
    set(deleteArmed, true)
    return
  }
  const answer = await run(() => plugin.request('task.delete', { id: task.id, projectId: task.projectId }))
  if (!answer) return
  applyRemoved(task.id)
  set(nav, { screen: 'tasks', list })
}

function patchDraft(change: Partial<{ title: string; content: string; due: string; priority: string }>): void {
  const d = read(draft)
  if (d) set(draft, { ...d, ...change })
}

// ---------- setup ----------

export function setup(ctx: PanelContext): void {
  // The detail edits are not persisted: reopen on the task's list, not on an empty detail.
  const start = read(nav)
  if (start.screen === 'task') set(nav, { screen: 'tasks', list: start.list })
  ctx.subscriptions.push(plugin.on('task.upserted', ({ task }) => applyTask(task)))
  ctx.subscriptions.push(plugin.on('task.removed', ({ id }) => applyRemoved(id)))
  // Another panel reloaded: take the worker's cached copy (no call to TickTick).
  ctx.subscriptions.push(
    plugin.on('data.reloaded', ({ loadedAt }) => {
      if (read(auth)?.connected && read(data)?.loadedAt !== loadedAt) void load()
    })
  )
  ctx.subscriptions.push(plugin.on('auth.changed', (payload) => set(auth, payload)))
  void run(() => plugin.request('auth.status')).then((answer) => {
    if (!answer) return
    set(auth, answer)
    if (answer.connected) void load()
  })
}

// ---------- screens ----------

function ErrorBar() {
  const text = read(error)
  if (!text) return null
  return (
    <Callout tone="danger" title="Something went wrong" icon="error">
      <Stack gap="xs">
        <Text size="sm">{text}</Text>
        <Row>
          <Button size="xs" variant="ghost" onPress={() => set(error, null)}>
            Dismiss
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function ConnectScreen() {
  return (
    <Stack gap="md">
      <Heading>Connect TickTick</Heading>
      <Text size="sm" muted>
        Paste a TickTick Open API access token. The plugin checks it with TickTick, then keeps it in
        your keychain (or in Orca's plugin storage when this machine has no keychain).
      </Text>
      <Input
        label="Access token"
        type="password"
        placeholder="Paste the token here"
        value={read(tokenDraft)}
        onChange={(v) => set(tokenDraft, v)}
        onSubmit={() => void connect()}
      />
      <Row>
        <Button icon="plug" disabled={read(busy) || !read(tokenDraft).trim()} onPress={connect}>
          {read(busy) ? 'Connecting…' : 'Connect'}
        </Button>
      </Row>
      <ErrorBar />
      <Separator />
      <Stack gap="xs">
        <Text size="xs" weight="semibold">
          Where do I get a token?
        </Text>
        <Text size="xs" muted>
          1. Already use the TickTick MCP? Copy TICKTICK_ACCESS_TOKEN from its .env file.
        </Text>
        <Text size="xs" muted>
          2. Or create an app on the TickTick developer site and run its OAuth flow once.
        </Text>
        <Link href="https://developer.ticktick.com/manage">developer.ticktick.com</Link>
      </Stack>
    </Stack>
  )
}

function ListsScreen() {
  const d = read(data)
  const tasks = d?.tasks ?? []
  const count = (list: string) => tasksOf(list, tasks).length
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>TickTick</Heading>
        <IconButton icon="refresh" label="Refresh" variant="ghost" disabled={read(busy)} onPress={() => load(true)} />
      </Row>
      <ErrorBar />
      {!d ? (
        <Skeleton lines={6} label="Loading lists" />
      ) : (
        <Stack gap="sm">
          <List label="Smart lists">
            {SMART.map((s) => (
              <ListItem
                key={s.id}
                icon={s.icon}
                title={s.name}
                description={`${count(s.id)} tasks`}
                onPress={() => set(nav, { screen: 'tasks', list: s.id })}
              />
            ))}
          </List>
          <List label="Lists">
            {d.projects.map((p) => (
              <ListItem
                key={p.id}
                title={p.name}
                description={`${count(p.id)} tasks`}
                onPress={() => set(nav, { screen: 'tasks', list: p.id })}
              />
            ))}
          </List>
        </Stack>
      )}
      <Separator />
      <Row justify="between" align="center">
        <Text size="xs" muted>
          Connected{read(auth)?.storedIn === 'keychain' ? ' · token in keychain' : ''}
        </Text>
        <Button size="xs" variant="ghost" onPress={disconnect}>
          Disconnect
        </Button>
      </Row>
    </Stack>
  )
}

function TaskRow({ list, task }: { list: string; task: TickTask }) {
  const due = dueLabel(task)
  const bits = [due, task.priority ? `${PRIORITY[task.priority] ?? ''} priority` : null].filter(Boolean)
  return (
    <Box direction="row" gap="xs" align="center" paddingY="xs">
      <Box grow>
        <Checkbox
          label={task.title}
          description={bits.length ? bits.join(' · ') : undefined}
          checked={false}
          disabled={read(busy)}
          onChange={(checked) => {
            if (checked) void complete(task)
          }}
        />
      </Box>
      <IconButton icon="next" label={`Open ${task.title}`} tooltip="Open" variant="ghost" size="sm" onPress={() => openTask(list, task)} />
    </Box>
  )
}

function TasksScreen({ list }: { list: string }) {
  const d = read(data)
  const tasks = tasksOf(list, d?.tasks ?? [])
  const done = read(lastDone)
  if (d && !SMART.some((x) => x.id === list) && !d.projects.some((p) => p.id === list)) {
    return (
      <Stack gap="md">
        <Row>
          <Button size="sm" variant="ghost" onPress={() => set(nav, { screen: 'lists' })}>
            ← Lists
          </Button>
        </Row>
        <EmptyState icon="info" title="This list no longer exists" description="It was closed or deleted in TickTick." />
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Button size="sm" variant="ghost" onPress={() => set(nav, { screen: 'lists' })}>
            ← Lists
          </Button>
          <Heading level={2}>{listName(list, d)}</Heading>
          <Badge>{tasks.length}</Badge>
        </Row>
        <IconButton icon="refresh" label="Refresh" variant="ghost" disabled={read(busy)} onPress={() => load(true)} />
      </Row>
      <Input
        label="Add task"
        labelHidden
        placeholder={list === 'today' || list === 'next7' ? '+ Add task to Inbox, due today' : '+ Add task'}
        value={read(newTitle)}
        disabled={read(busy)}
        onChange={(v) => set(newTitle, v)}
        onSubmit={async () => {
          if (await addTask(list, read(newTitle))) set(newTitle, '')
        }}
      />
      <ErrorBar />
      {done ? (
        <Callout tone="success" icon="check">
          <Row justify="between" align="center">
            <Text size="sm" truncate>
              Completed “{done.title}”
            </Text>
            <Row gap="xs">
              <Button size="xs" variant="ghost" onPress={undo}>
                Undo
              </Button>
              <IconButton icon="close" label="Hide" size="xs" variant="ghost" onPress={() => set(lastDone, null)} />
            </Row>
          </Row>
        </Callout>
      ) : null}
      {!d ? (
        <Skeleton lines={5} label="Loading tasks" />
      ) : tasks.length === 0 ? (
        <EmptyState icon="check" title="Nothing here" description="Add a task above." />
      ) : (
        <Stack gap="none">
          {tasks.map((t) => (
            <TaskRow key={t.id} list={list} task={t} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function TaskScreen({ list }: { list: string }) {
  const task = read(currentTask)
  const d = read(draft)
  const back = () => set(nav, { screen: 'tasks', list })
  if (!task || !d) {
    return (
      <Stack gap="md">
        <Row gap="xs" align="center">
          <Button size="sm" variant="ghost" onPress={back}>
            ← Back
          </Button>
          <Heading level={2}>Task</Heading>
        </Row>
        <EmptyState icon="info" title="This task is gone" description="It was completed or deleted." />
      </Stack>
    )
  }
  const project = read(data)?.projects.find((p) => p.id === task.projectId)?.name ?? 'Inbox'
  const dirty =
    d.title !== task.title ||
    d.content !== task.content ||
    Number(d.priority) !== task.priority ||
    d.due !== (parseDue(task.dueDate) ? dayKey(parseDue(task.dueDate) as Date) : '')
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Button size="sm" variant="ghost" onPress={back}>
            {`← ${listName(list, read(data))}`}
          </Button>
          <Text size="sm" muted truncate>
            {project}
          </Text>
        </Row>
        <Button
          icon="check"
          size="sm"
          variant="outline"
          tone="success"
          disabled={read(busy)}
          onPress={async () => {
            await complete(task)
            back()
          }}
        >
          Complete
        </Button>
      </Row>
      <ErrorBar />
      <Input label="Title" value={d.title} onChange={(v) => patchDraft({ title: v })} onSubmit={() => save(task)} />
      <Stack gap="xs">
        <Input
          label="Due date"
          placeholder="YYYY-MM-DD"
          value={d.due}
          invalid={d.due.trim() !== '' && toTickDate(d.due) === null}
          onChange={(v) => patchDraft({ due: v })}
        />
        <Row gap="xs" wrap>
          <Button size="xs" variant="ghost" onPress={() => patchDraft({ due: dayKey(new Date()) })}>
            Today
          </Button>
          <Button size="xs" variant="ghost" onPress={() => patchDraft({ due: dayKey(addDays(new Date(), 1)) })}>
            Tomorrow
          </Button>
          <Button size="xs" variant="ghost" onPress={() => patchDraft({ due: dayKey(addDays(new Date(), 7)) })}>
            Next week
          </Button>
          <Button size="xs" variant="ghost" onPress={() => patchDraft({ due: '' })}>
            No date
          </Button>
        </Row>
      </Stack>
      <Select
        label="Priority"
        value={d.priority}
        options={[
          { value: '0', label: 'None' },
          { value: '1', label: 'Low' },
          { value: '3', label: 'Medium' },
          { value: '5', label: 'High' }
        ]}
        onChange={(v) => patchDraft({ priority: v })}
      />
      <Textarea
        label="Description"
        rows={6}
        placeholder="Write something"
        value={d.content}
        onChange={(v) => patchDraft({ content: v })}
        onSubmit={() => save(task)}
      />
      <Row justify="between" align="center">
        <Button
          icon="delete"
          size="sm"
          variant={read(deleteArmed) ? 'solid' : 'ghost'}
          tone="danger"
          disabled={read(busy)}
          onPress={() => remove(list, task)}
        >
          {read(deleteArmed) ? 'Press again to delete' : 'Delete'}
        </Button>
        <Button icon="check" disabled={read(busy) || !dirty || !d.title.trim()} onPress={() => save(task)}>
          {read(busy) ? 'Saving…' : 'Save'}
        </Button>
      </Row>
    </Stack>
  )
}

export default function Panel() {
  const a = read(auth)
  if (a === null) return <Skeleton lines={4} label="Starting TickTick" />
  if (!a.connected) return <ConnectScreen />
  const n = read(nav)
  if (n.screen === 'tasks') return <TasksScreen list={n.list} />
  if (n.screen === 'task') return <TaskScreen list={n.list} />
  return <ListsScreen />
}
