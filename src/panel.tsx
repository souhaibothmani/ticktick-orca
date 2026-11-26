// No build step: Orca strips the types and compiles the JSX when the panel loads.
// Three screens, one at a time: Lists -> Tasks -> Task, with a back button (Connect comes first).
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  derived,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  Markdown,
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
  type OrcaNode,
  type PanelContext,
  type Tone
} from 'orca'
import type { AuthStatus, TaskDraft, TaskPatch, TickData, TickTask } from './protocol'

// ---------- state ----------

type Nav = { screen: 'lists' } | { screen: 'tasks'; list: string } | { screen: 'task'; list: string; taskId: string }
type Draft = { title: string; content: string; due: string; priority: string }

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
/** The task whose tick waits for "Complete" or "Cancel". */
const confirmTick = atom<string | null>(null)
/** Completed tasks of the open list, loaded when its section opens; null = not loaded. */
const done = atom<{ list: string; tasks: TickTask[] } | null>(null)
const doneOpen = atom(false)
/** Detail screen: edit form open, and its values. */
const editing = atom(false)
const draft = atom<Draft | null>(null)
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

function dueKey(task: TickTask): string {
  const d = parseDue(task.dueDate)
  return d ? dayKey(d) : ''
}

/** YYYY-MM-DD -> local midnight in TickTick's format, e.g. 2026-11-26T23:00:00+0000. */
function toTickDate(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (dayKey(d) !== day.trim()) return null
  return d.toISOString().slice(0, 19) + '+0000'
}

function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** "Today", "Tomorrow", "Overdue · 3 Nov" or "Mon 1 Dec", with the tone to draw it in. */
function dueInfo(task: TickTask): { label: string; tone: Tone } | null {
  const d = parseDue(task.dueDate)
  if (!d) return null
  const today = dayKey(new Date())
  const key = dayKey(d)
  if (key === today) return { label: 'Today', tone: 'accent' }
  if (key === dayKey(addDays(new Date(), 1))) return { label: 'Tomorrow', tone: 'neutral' }
  if (key < today) return { label: `Overdue · ${shortDate(d)}`, tone: 'danger' }
  return { label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), tone: 'neutral' }
}

// ---------- tasks ----------

const PRIORITY: Record<number, { label: string; tone: Tone }> = {
  1: { label: 'Low', tone: 'accent' },
  3: { label: 'Medium', tone: 'warning' },
  5: { label: 'High', tone: 'danger' }
}

/** Open tasks of a list: dated first by date, then the rest by priority and TickTick's order. */
function tasksOf(list: string, all: TickTask[]): TickTask[] {
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

function listName(list: string, d: TickData | null): string {
  return d?.projects.find((p) => p.id === list)?.name ?? 'Tasks'
}

/** One line under a task title: due date and priority. */
function meta(task: TickTask): string | undefined {
  const bits = [dueInfo(task)?.label, PRIORITY[task.priority] ? `${PRIORITY[task.priority].label} priority` : null]
  const line = bits.filter(Boolean).join(' · ')
  return line || undefined
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
  if (d) {
    const rest = d.tasks.filter((t) => t.id !== task.id)
    set(data, { ...d, tasks: task.status === 0 ? [...rest, task] : rest })
  }
  // A reopened task leaves the Completed section.
  const c = read(done)
  if (c && task.status === 0 && c.tasks.some((t) => t.id === task.id)) {
    set(done, { ...c, tasks: c.tasks.filter((t) => t.id !== task.id) })
  }
}

function applyRemoved(id: string): void {
  const d = read(data)
  if (d && d.tasks.some((t) => t.id === id)) set(data, { ...d, tasks: d.tasks.filter((t) => t.id !== id) })
}

/** Code of the last failed call, for callers that react to the kind of failure. */
let lastCode: string | undefined

/**
 * Runs a worker call with the spinner and error bar; a refused token sends you to Connect.
 * `quiet` (automatic reloads) keeps the message already shown.
 */
async function run<T>(work: () => Promise<T>, quiet = false): Promise<T | undefined> {
  update(pending, (n) => n + 1)
  if (!quiet) set(error, null)
  lastCode = undefined
  let stale = false
  try {
    return await work()
  } catch (e) {
    const code = (e as { code?: string }).code
    lastCode = code
    if (code === 'not_permitted') set(auth, { connected: false, storedIn: null })
    // The task changed in TickTick meanwhile (completed, moved or deleted there): reload once.
    // Only task calls answer `conflict`, so this reload cannot trigger itself again.
    if (code === 'conflict') stale = true
    if (!quiet || !read(error)) set(error, message(e))
    return undefined
  } finally {
    update(pending, (n) => n - 1)
    // Next tick: the caller must read `lastCode` before the reload resets it.
    if (stale) setTimeout(() => void load(true, true), 0)
  }
}

async function load(fresh = false, quiet = false): Promise<void> {
  const answer = await run(() => plugin.request('data.load', { fresh }), quiet)
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
  set(done, null)
}

function openList(list: string): void {
  set(confirmTick, null)
  set(done, null)
  set(doneOpen, false)
  set(newTitle, '')
  set(nav, { screen: 'tasks', list })
}

async function addTask(list: string): Promise<void> {
  const title = read(newTitle).trim()
  if (!title) return
  // Orca refuses a request with an undefined field: send only fields that have a value.
  const input: TaskDraft = { title, projectId: list }
  const answer = await run(() => plugin.request('task.create', input))
  if (!answer) return
  applyTask(answer.task)
  set(newTitle, '')
}

/** The tick asks first; this runs after "Complete". */
async function complete(task: TickTask): Promise<void> {
  set(confirmTick, null)
  applyRemoved(task.id)
  const ref = task.repeatFlag
    ? { id: task.id, projectId: task.projectId, repeats: true }
    : { id: task.id, projectId: task.projectId }
  const answer = await run(() => plugin.request('task.complete', ref))
  if (!answer) {
    // Put back only this row, unless TickTick says the task is gone.
    if (lastCode !== 'conflict' && !read(data)?.tasks.some((t) => t.id === task.id)) applyTask(task)
    return
  }
  // A repeating task comes back with its next date.
  if (answer.task) {
    applyTask(answer.task)
    return
  }
  const c = read(done)
  if (c && c.list === task.projectId) {
    const finished = { ...task, status: 2, completedTime: new Date().toISOString() }
    set(done, { ...c, tasks: [finished, ...c.tasks.filter((t) => t.id !== task.id)] })
  }
}

async function reopen(task: TickTask): Promise<void> {
  const answer = await run(() => plugin.request('task.reopen', { id: task.id, projectId: task.projectId }))
  if (answer) applyTask(answer.task)
}

async function loadDone(list: string): Promise<void> {
  const answer = await run(() => plugin.request('tasks.completed', { projectId: list }))
  if (answer) set(done, { list, tasks: answer.tasks })
}

function openTask(list: string, task: TickTask): void {
  set(confirmTick, null)
  set(editing, false)
  set(deleteArmed, false)
  set(draft, null)
  set(nav, { screen: 'task', list, taskId: task.id })
}

function startEdit(task: TickTask): void {
  set(draft, { title: task.title, content: task.content, due: dueKey(task), priority: String(task.priority) })
  set(editing, true)
}

async function save(task: TickTask): Promise<void> {
  const d = read(draft)
  if (!d) return
  const patch: TaskPatch = { id: task.id, projectId: task.projectId }
  if (d.title !== task.title) patch.title = d.title
  if (d.content !== task.content) patch.content = d.content
  if (Number(d.priority) !== task.priority) patch.priority = Number(d.priority)
  if (d.due !== dueKey(task)) {
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
  if (Object.keys(patch).length > 2) {
    const answer = await run(() => plugin.request('task.update', patch))
    if (!answer) return
    applyTask(answer.task)
  }
  set(editing, false)
}

async function remove(list: string, task: TickTask): Promise<void> {
  const answer = await run(() => plugin.request('task.delete', { id: task.id, projectId: task.projectId }))
  if (!answer) return
  applyRemoved(task.id)
  set(deleteArmed, false)
  set(nav, { screen: 'tasks', list })
}

function patchDraft(change: Partial<Draft>): void {
  const d = read(draft)
  if (d) set(draft, { ...d, ...change })
}

// ---------- setup ----------

export function setup(ctx: PanelContext): void {
  // Detail state is not persisted: reopen on the task's list, not on an empty detail.
  const start = read(nav)
  if (start.screen === 'task') set(nav, { screen: 'tasks', list: start.list })
  ctx.subscriptions.push(plugin.on('auth.changed', (payload) => set(auth, payload)))
  ctx.subscriptions.push(plugin.on('task.upserted', ({ task }) => applyTask(task)))
  ctx.subscriptions.push(plugin.on('task.removed', ({ id }) => applyRemoved(id)))
  // Another panel reloaded: take the worker's cached copy (no call to TickTick).
  ctx.subscriptions.push(
    plugin.on('data.reloaded', ({ loadedAt }) => {
      if (read(auth)?.connected && read(data)?.loadedAt !== loadedAt) void load(false, true)
    })
  )
  void run(() => plugin.request('auth.status')).then((answer) => {
    if (!answer) return
    set(auth, answer)
    if (answer.connected) void load()
  })
}

// ---------- pieces ----------

/** Scrolling content with a footer kept at the bottom of the panel. */
function Page({ children, footer }: { children?: OrcaNode; footer?: OrcaNode }) {
  return (
    <Box direction="column" height="100%" gap="md">
      <Box grow scroll="y" gap="md">
        {children}
      </Box>
      {footer ? (
        <Box shrink={false} gap="sm">
          <Separator />
          {footer}
        </Box>
      ) : null}
    </Box>
  )
}

function ErrorBar() {
  const text = read(error)
  if (!text) return null
  return (
    <Callout tone="danger" icon="error">
      <Row justify="between" align="center" gap="sm">
        <Text size="sm">{text}</Text>
        <IconButton icon="close" label="Dismiss" size="xs" variant="ghost" onPress={() => set(error, null)} />
      </Row>
    </Callout>
  )
}

function BackBar({ label, onBack, right }: { label: string; onBack: () => void; right?: OrcaNode }) {
  return (
    <Row justify="between" align="center">
      <Button size="sm" variant="ghost" onPress={onBack}>
        {`← ${label}`}
      </Button>
      {right ?? null}
    </Row>
  )
}

function RefreshButton() {
  return (
    <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={read(busy)} onPress={() => load(true)} />
  )
}

// ---------- screens ----------

function ConnectScreen() {
  return (
    <Page>
      <Stack gap="xs">
        <Heading>Connect TickTick</Heading>
        <Text size="sm" muted>
          Paste a TickTick Open API access token. The plugin checks it with TickTick, then keeps it
          in your keychain (or in Orca's plugin storage when this machine has no keychain).
        </Text>
      </Stack>
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
      <Callout tone="neutral" icon="info" title="Where do I get a token?">
        <Stack gap="xs">
          <Text size="xs">Already use the TickTick MCP? Copy TICKTICK_ACCESS_TOKEN from its .env file.</Text>
          <Text size="xs">Or create an app on the TickTick developer site and run its OAuth flow once.</Text>
          <Link href="https://developer.ticktick.com/manage">developer.ticktick.com</Link>
        </Stack>
      </Callout>
    </Page>
  )
}

function ListsScreen() {
  const d = read(data)
  const total = d?.tasks.length ?? 0
  return (
    <Page
      footer={
        <Row justify="between" align="center">
          <Text size="xs" muted>
            {read(auth)?.storedIn === 'keychain' ? 'Connected · token in keychain' : 'Connected'}
          </Text>
          <Button size="xs" variant="ghost" onPress={disconnect}>
            Disconnect
          </Button>
        </Row>
      }
    >
      <Row justify="between" align="center">
        <Stack gap="none">
          <Heading>TickTick</Heading>
          <Text size="xs" muted>
            {d ? `${total} open tasks` : 'Loading…'}
          </Text>
        </Stack>
        <RefreshButton />
      </Row>
      <ErrorBar />
      {!d ? (
        <Skeleton lines={5} label="Loading lists" />
      ) : d.projects.length === 0 ? (
        <EmptyState icon="folder" title="No lists" description="Create a list in TickTick, then refresh." />
      ) : (
        <List label="Lists">
          {d.projects.map((p) => {
            const open = tasksOf(p.id, d.tasks)
            const overdue = open.filter((t) => dueInfo(t)?.tone === 'danger').length
            return (
              <ListItem
                key={p.id}
                title={p.name}
                description={`${open.length} open${overdue ? ` · ${overdue} overdue` : ''}`}
                onPress={() => openList(p.id)}
              />
            )
          })}
        </List>
      )}
    </Page>
  )
}

/** An open task: tick button (asks first), then the title, which opens the task. */
function TaskRow({ list, task }: { list: string; task: TickTask }) {
  if (read(confirmTick) === task.id) {
    return (
      <Box direction="row" gap="sm" align="center" justify="between" padding="sm" radius="md" background="success">
        <Box grow minWidth={0}>
          <Text size="sm" weight="medium" truncate>
            {`Complete “${task.title}”?`}
          </Text>
        </Box>
        <Row gap="xs">
          <Button size="xs" variant="ghost" onPress={() => set(confirmTick, null)}>
            Cancel
          </Button>
          <Button size="xs" tone="success" icon="check" disabled={read(busy)} onPress={() => complete(task)}>
            Complete
          </Button>
        </Row>
      </Box>
    )
  }
  return (
    <Box direction="row" gap="xs" align="center">
      <IconButton
        icon="check"
        label={`Complete ${task.title}`}
        tooltip={task.repeatFlag ? 'Complete (repeats)' : 'Complete'}
        variant="outline"
        size="sm"
        tone={PRIORITY[task.priority]?.tone ?? 'neutral'}
        disabled={read(busy)}
        onPress={() => set(confirmTick, task.id)}
      />
      <Box grow minWidth={0}>
        <List label={task.title}>
          <ListItem title={task.title} description={meta(task)} onPress={() => openTask(list, task)} />
        </List>
      </Box>
    </Box>
  )
}

/** A completed task: the filled tick unticks it. */
function DoneRow({ task }: { task: TickTask }) {
  const at = parseDue(task.completedTime)
  return (
    <Box direction="row" gap="sm" align="center">
      <IconButton
        icon="check"
        label={`Untick ${task.title}`}
        tooltip="Mark as not done"
        variant="solid"
        tone="success"
        size="sm"
        disabled={read(busy)}
        onPress={() => reopen(task)}
      />
      <Box grow minWidth={0}>
        <Text size="sm" muted truncate>
          {task.title}
        </Text>
        {at ? (
          <Text size="xs" muted>
            {`Done ${shortDate(at)}`}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

function CompletedSection({ list }: { list: string }) {
  const c = read(done)
  const loaded = c && c.list === list ? c.tasks : null
  return (
    <Collapsible
      title={loaded ? `Completed · ${loaded.length}` : 'Completed'}
      description="Last 30 days"
      open={read(doneOpen)}
      onChange={(open) => {
        set(doneOpen, open)
        if (open && !loaded) void loadDone(list)
      }}
    >
      {loaded === null ? (
        <Skeleton lines={3} label="Loading completed tasks" />
      ) : loaded.length === 0 ? (
        <Text size="sm" muted>
          Nothing completed in the last 30 days.
        </Text>
      ) : (
        <Stack gap="sm">
          {loaded.map((t) => (
            <DoneRow key={t.id} task={t} />
          ))}
        </Stack>
      )}
    </Collapsible>
  )
}

function TasksScreen({ list }: { list: string }) {
  const d = read(data)
  const back = () => set(nav, { screen: 'lists' })
  if (d && !d.projects.some((p) => p.id === list)) {
    return (
      <Page>
        <BackBar label="Lists" onBack={back} />
        <EmptyState icon="info" title="This list no longer exists" description="It was closed or deleted in TickTick." />
      </Page>
    )
  }
  const tasks = tasksOf(list, d?.tasks ?? [])
  return (
    <Page>
      <BackBar label="Lists" onBack={back} right={<RefreshButton />} />
      <Row gap="sm" align="center">
        <Heading>{listName(list, d)}</Heading>
        <Badge tone="accent">{tasks.length}</Badge>
      </Row>
      <Input
        label="Add task"
        labelHidden
        placeholder="+ Add task, press Enter"
        value={read(newTitle)}
        disabled={read(busy)}
        onChange={(v) => set(newTitle, v)}
        onSubmit={() => void addTask(list)}
      />
      <ErrorBar />
      {!d ? (
        <Skeleton lines={5} label="Loading tasks" />
      ) : tasks.length === 0 ? (
        <EmptyState icon="check" title="All done" description="No open tasks in this list." />
      ) : (
        <Stack gap="xs">
          {tasks.map((t) => (
            <TaskRow key={t.id} list={list} task={t} />
          ))}
        </Stack>
      )}
      <Separator />
      <CompletedSection list={list} />
    </Page>
  )
}

function TaskView({ list, task }: { list: string; task: TickTask }) {
  const due = dueInfo(task)
  const priority = PRIORITY[task.priority]
  return (
    <Stack gap="md">
      {read(confirmTick) === task.id ? (
        <Callout tone="success" icon="check" title="Complete this task?">
          <Row gap="xs">
            <Button
              size="sm"
              tone="success"
              icon="check"
              disabled={read(busy)}
              onPress={async () => {
                await complete(task)
                set(nav, { screen: 'tasks', list })
              }}
            >
              Complete
            </Button>
            <Button size="sm" variant="ghost" onPress={() => set(confirmTick, null)}>
              Cancel
            </Button>
          </Row>
        </Callout>
      ) : null}
      {read(deleteArmed) ? (
        <Callout tone="danger" icon="delete" title="Delete this task?">
          <Stack gap="xs">
            <Text size="sm">It is removed from TickTick for good.</Text>
            <Row gap="xs">
              <Button size="sm" tone="danger" icon="delete" disabled={read(busy)} onPress={() => remove(list, task)}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onPress={() => set(deleteArmed, false)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      <Row gap="xs" wrap align="center">
        <Button
          size="sm"
          variant="outline"
          tone="success"
          icon="check"
          disabled={read(busy)}
          onPress={() => set(confirmTick, task.id)}
        >
          Complete
        </Button>
        {due ? <Badge tone={due.tone}>{due.label}</Badge> : <Badge>No date</Badge>}
        {priority ? <Badge tone={priority.tone}>{`${priority.label} priority`}</Badge> : null}
        {task.repeatFlag ? <Badge>Repeats</Badge> : null}
      </Row>
      <Heading level={1}>{task.title}</Heading>
      {task.content.trim() ? (
        <Box padding="md" radius="md" background="muted">
          <Markdown content={task.content} />
        </Box>
      ) : (
        <Text size="sm" muted>
          No description. Press Edit to add one.
        </Text>
      )}
    </Stack>
  )
}

function TaskEdit({ task }: { task: TickTask }) {
  const d = read(draft)
  if (!d) return null
  const dirty =
    d.title !== task.title || d.content !== task.content || Number(d.priority) !== task.priority || d.due !== dueKey(task)
  return (
    <Stack gap="md">
      <Input label="Title" value={d.title} onChange={(v) => patchDraft({ title: v })} onSubmit={() => save(task)} />
      <Textarea
        label="Description"
        rows={8}
        placeholder="Write something (Markdown works)"
        value={d.content}
        onChange={(v) => patchDraft({ content: v })}
        onSubmit={() => save(task)}
      />
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
      <Row justify="end" gap="xs">
        <Button variant="ghost" onPress={() => set(editing, false)}>
          Cancel
        </Button>
        <Button icon="check" disabled={read(busy) || !dirty || !d.title.trim()} onPress={() => save(task)}>
          {read(busy) ? 'Saving…' : 'Save'}
        </Button>
      </Row>
    </Stack>
  )
}

function TaskScreen({ list }: { list: string }) {
  const task = read(currentTask)
  const d = read(data)
  const back = () => {
    set(editing, false)
    set(nav, { screen: 'tasks', list })
  }
  if (!task) {
    return (
      <Page>
        <BackBar label={listName(list, d)} onBack={back} />
        <EmptyState icon="info" title="This task is gone" description="It was completed or deleted." />
      </Page>
    )
  }
  const isEditing = read(editing)
  return (
    <Page
      footer={
        isEditing ? undefined : (
          <Row justify="between" align="center">
            <Text size="xs" muted truncate>
              {listName(list, d)}
            </Text>
            <IconButton
              icon="delete"
              label="Delete"
              size="sm"
              variant="ghost"
              tone="danger"
              onPress={() => set(deleteArmed, true)}
            />
          </Row>
        )
      }
    >
      <BackBar
        label={listName(list, d)}
        onBack={back}
        right={
          isEditing ? null : (
            <Button size="sm" variant="ghost" icon="edit" onPress={() => startEdit(task)}>
              Edit
            </Button>
          )
        }
      />
      <ErrorBar />
      {isEditing ? <TaskEdit task={task} /> : <TaskView list={list} task={task} />}
    </Page>
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
