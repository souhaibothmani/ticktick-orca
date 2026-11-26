// The TickTick panel: plain DOM in Orca's sandboxed frame. It talks only to the plugin's own
// worker (`orca.plugin.request` / `orca.plugin.on`), which is the part that calls TickTick.
// Screens: Connect -> Lists -> Tasks -> Task, with a back button.
import {
  PRIORITY,
  dueKey,
  dueLabel,
  fieldsOf,
  followTask,
  parseDue,
  patchOf,
  shortDate,
  tasksOf
} from './logic.js'

const orca = window.orca
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const NAV_KEY = 'ticktick.nav'

// ---------- icons (lucide paths, drawn inline: the frame has no network) ----------

const ICONS = {
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  note: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'
}

function icon(name, cls) {
  const span = document.createElement('span')
  span.innerHTML = `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}>${ICONS[name]}</svg>`
  return span.firstChild
}

// ---------- tiny DOM helper ----------

/** h('div', { class, key, onclick, ...attrs }, ...children). `key` lets render() keep focus. */
function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'key') el.dataset.k = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'value') el.value = v
    else if (k === 'disabled') el.disabled = true
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return el
}

// ---------- state ----------

function loadNav() {
  try {
    const nav = JSON.parse(localStorage.getItem(NAV_KEY) || 'null')
    // The task page is not restored (its edits are not kept): reopen on its list.
    if (nav && nav.screen === 'task') return { screen: 'tasks', list: nav.list }
    if (nav && (nav.screen === 'tasks' || nav.screen === 'lists')) return nav
  } catch {}
  return { screen: 'lists' }
}

const S = {
  auth: null,
  data: null,
  nav: loadNav(),
  pending: 0,
  error: null,
  /** The task whose tick waits for "Complete" or "Cancel". */
  confirmTick: null,
  /** Completed tasks of the open list, loaded when its section opens. */
  done: null,
  doneOpen: false,
  doneFailed: false,
  /** The task page: what is typed, saved by itself a moment after typing stops. */
  draft: null,
  saveState: 'saved',
  deleteArmed: false,
  menu: null
}

function go(nav) {
  S.nav = nav
  S.menu = null
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify(nav))
  } catch {}
  render()
}

const busy = () => S.pending > 0

function listName(list) {
  return S.data?.projects.find((p) => p.id === list)?.name ?? 'Tasks'
}

// ---------- worker calls ----------

let lastCode
async function run(work, quiet = false) {
  S.pending += 1
  if (!quiet) S.error = null
  lastCode = undefined
  let stale = false
  render()
  try {
    return await work()
  } catch (e) {
    lastCode = e && e.code
    if (lastCode === 'not_permitted') S.auth = { connected: false, storedIn: null }
    // The task changed in TickTick meanwhile: reload once. Only task calls answer `conflict`,
    // so this reload cannot trigger itself again.
    if (lastCode === 'conflict') stale = true
    if (!quiet || !S.error) S.error = (e && e.message) || String(e)
    return undefined
  } finally {
    S.pending -= 1
    render()
    // Next tick: the caller must read `lastCode` before the reload resets it.
    if (stale) setTimeout(() => void load(true, true), 0)
  }
}

const request = (name, input) => orca.plugin.request(name, input)

async function load(fresh = false, quiet = false) {
  const answer = await run(() => request('data.load', { fresh }), quiet)
  if (!answer) return
  S.data = answer
  const open = S.draft && answer.tasks.find((t) => t.id === S.draft.taskId)
  if (open) S.draft = followTask(S.draft, open)
  render()
}

/** A task the worker answered or announced: in the lists if open, out if done. */
function applyTask(task) {
  if (S.draft && S.draft.taskId === task.id && task.status === 0) S.draft = followTask(S.draft, task)
  if (S.data) {
    const rest = S.data.tasks.filter((t) => t.id !== task.id)
    S.data = { ...S.data, tasks: task.status === 0 ? [...rest, task] : rest }
  }
  if (S.done && task.status === 0) S.done = { ...S.done, tasks: S.done.tasks.filter((t) => t.id !== task.id) }
  render()
}

function applyRemoved(id) {
  if (S.data) S.data = { ...S.data, tasks: S.data.tasks.filter((t) => t.id !== id) }
  render()
}

async function connect(token) {
  const answer = await run(() => request('auth.connect', { token }))
  if (!answer) return
  S.auth = answer
  go({ screen: 'lists' })
  await load(true)
}

async function disconnect() {
  const answer = await run(() => request('auth.disconnect'))
  if (!answer) return
  S.auth = answer
  S.data = null
  S.done = null
  render()
}

function openList(list) {
  S.confirmTick = null
  S.done = null
  S.doneOpen = false
  S.doneFailed = false
  go({ screen: 'tasks', list })
}

async function addTask(list, input) {
  const title = input.value.trim()
  if (!title) return
  const answer = await run(() => request('task.create', { title, projectId: list }))
  if (!answer) return
  input.value = ''
  applyTask(answer.task)
}

async function complete(task) {
  S.confirmTick = null
  applyRemoved(task.id)
  const ref = task.repeatFlag ? { id: task.id, projectId: task.projectId, repeats: true } : { id: task.id, projectId: task.projectId }
  const answer = await run(() => request('task.complete', ref))
  if (!answer) {
    // Put back only this row, unless TickTick says the task is gone.
    if (lastCode !== 'conflict' && !S.data?.tasks.some((t) => t.id === task.id)) applyTask(task)
    return
  }
  // A repeating task comes back with its next date.
  if (answer.task) return applyTask(answer.task)
  if (S.done && S.done.list === task.projectId) {
    const finished = { ...task, status: 2, completedTime: new Date().toISOString() }
    S.done = { ...S.done, tasks: [finished, ...S.done.tasks.filter((t) => t.id !== task.id)] }
    render()
  }
}

async function reopen(task) {
  const answer = await run(() => request('task.reopen', { id: task.id, projectId: task.projectId }))
  if (answer) applyTask(answer.task)
}

async function loadDone(list) {
  S.doneFailed = false
  const answer = await run(() => request('tasks.completed', { projectId: list }))
  if (answer) S.done = { list, tasks: answer.tasks }
  else S.doneFailed = true
  render()
}

async function remove(list, task) {
  const answer = await run(() => request('task.delete', { id: task.id, projectId: task.projectId }))
  if (!answer) return
  S.deleteArmed = false
  applyRemoved(task.id)
  go({ screen: 'tasks', list })
}

// ---------- the task page saves by itself ----------

function openTask(list, task) {
  S.confirmTick = null
  S.deleteArmed = false
  const fields = fieldsOf(task)
  S.draft = { ...fields, taskId: task.id, base: fields }
  S.saveState = 'saved'
  go({ screen: 'task', list, taskId: task.id })
}

let saveTimer
let flushing = null
let saveAgain = false

const draftTask = () => (S.draft ? S.data?.tasks.find((t) => t.id === S.draft.taskId) : undefined)

/** One round of what is typed now; false when it failed. */
async function saveOnce() {
  const task = draftTask()
  if (!S.draft || !task) return true
  const { patch } = patchOf(S.draft, task, ZONE)
  if (!patch) return true
  setSaveState('saving')
  const answer = await run(() => request('task.update', patch))
  // applyTask moves `base` to what TickTick now has, so the next round sends only newer typing.
  if (answer) applyTask(answer.task)
  return answer !== undefined
}

/** Sends what is typed now. One save at a time, so TickTick gets the edits in order. */
function flush() {
  clearTimeout(saveTimer)
  if (flushing) {
    saveAgain = true
    return flushing
  }
  flushing = (async () => {
    let ok = true
    do {
      saveAgain = false
      ok = await saveOnce()
    } while (saveAgain && ok)
    const task = draftTask()
    const left = S.draft && task ? patchOf(S.draft, task, ZONE) : { patch: null, held: false }
    setSaveState(!ok ? 'failed' : left.held ? 'invalid' : left.patch ? 'pending' : 'saved')
  })().finally(() => {
    flushing = null
  })
  return flushing
}

/**
 * Typing waits for a pause of 2.5 s (one call, not one per key: TickTick allows 100 a minute and
 * the MCP shares them); a picked date or priority saves at once.
 */
function patchDraft(change, now = false) {
  if (!S.draft) return
  S.draft = { ...S.draft, ...change }
  setSaveState('pending')
  clearTimeout(saveTimer)
  if (now) void flush()
  else saveTimer = setTimeout(() => void flush(), 2500)
}

const SAVE_TEXT = {
  saved: 'Saved',
  pending: 'Editing…',
  saving: 'Saving…',
  invalid: 'Title or date not saved: a title is needed',
  failed: 'Not saved, see the error above'
}

/** Updates only the footer text: typing must not rebuild the page under the cursor. */
function setSaveState(state) {
  S.saveState = state
  const el = document.querySelector('[data-k="save-state"]')
  if (el) {
    el.textContent = SAVE_TEXT[state]
    el.classList.toggle('bad', state === 'invalid' || state === 'failed')
  }
}

// ---------- pieces ----------

function page(body, foot) {
  return h('div', { class: 'page' }, h('div', { class: 'body', key: 'body' }, body), foot ? h('div', { class: 'foot' }, foot) : null)
}

function errorBanner() {
  if (!S.error) return null
  return h(
    'div',
    { class: 'banner error' },
    icon('alert'),
    h('div', { class: 'msg' }, S.error),
    h('button', { class: 'icon-btn', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => ((S.error = null), render()) }, icon('x'))
  )
}

function refreshButton() {
  return h(
    'button',
    { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', disabled: busy(), onclick: () => load(true) },
    icon('refresh', busy() ? 'spin' : '')
  )
}

function backButton(label, onclick) {
  return h('button', { class: 'back', onclick }, icon('back'), h('span', {}, label))
}

/** The checkbox square, coloured by priority. */
function checkbox(task, onclick, { on = false, disabled = false, title } = {}) {
  const p = PRIORITY[task.priority]?.key ?? 'none'
  return h(
    'button',
    {
      class: `check p-${p}${on ? ' on' : ''}`,
      title: title ?? (on ? 'Mark as not done' : 'Complete'),
      'aria-label': `${on ? 'Untick' : 'Complete'} ${task.title}`,
      disabled: disabled || busy(),
      onclick: (e) => {
        e.stopPropagation()
        onclick()
      }
    },
    icon('check')
  )
}

// ---------- screens ----------

function connectScreen() {
  const input = h('input', {
    class: 'field',
    type: 'password',
    placeholder: 'Paste your TickTick access token',
    key: 'token',
    onkeydown: (e) => e.key === 'Enter' && connect(input.value)
  })
  return page(
    h(
      'div',
      { class: 'connect' },
      h('h1', {}, 'Connect TickTick'),
      h('p', {}, 'The plugin checks the token with TickTick, then keeps it in your keychain.'),
      input,
      h('button', { class: 'btn primary', disabled: busy(), onclick: () => connect(input.value) }, busy() ? 'Connecting…' : 'Connect'),
      h('div', { style: 'height:10px' }),
      errorBanner(),
      h(
        'div',
        { class: 'how' },
        h('b', {}, 'Where do I get a token? '),
        'Copy TICKTICK_ACCESS_TOKEN from the TickTick MCP .env file, or create an app on ',
        h('a', { onclick: () => orca.shell?.openExternal('https://developer.ticktick.com/manage') }, 'developer.ticktick.com'),
        ' and run its OAuth flow once.'
      )
    )
  )
}

function listsScreen() {
  const d = S.data
  const body = [
    h('div', { class: 'bar' }, h('h1', { style: 'margin:0' }, 'TickTick'), h('div', { class: 'spacer' }), refreshButton()),
    errorBanner()
  ]
  if (!d) body.push(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))
  else if (d.projects.length === 0) body.push(h('div', { class: 'empty' }, 'No lists. Create one in TickTick, then refresh.'))
  else
    for (const p of d.projects) {
      const open = tasksOf(p.id, d.tasks)
      const overdue = open.filter((t) => dueLabel(dueKey(t))?.kind === 'overdue').length
      body.push(
        h(
          'button',
          { class: 'row', key: `list-${p.id}`, onclick: () => openList(p.id) },
          h('span', { class: 'name' }, p.name),
          overdue ? h('span', { class: 'num overdue', title: `${overdue} overdue` }, String(overdue)) : null,
          h('span', { class: 'num' }, String(open.length))
        )
      )
    }
  return page(body, [
    h('span', { class: 'grow' }, S.auth?.storedIn === 'keychain' ? 'Connected · token in keychain' : 'Connected'),
    h('button', { class: 'btn ghost', onclick: disconnect }, 'Disconnect')
  ])
}

function taskRow(list, task) {
  if (S.confirmTick === task.id) {
    return h(
      'div',
      { class: 'ask', key: `ask-${task.id}` },
      h('span', { class: 'q' }, `Complete “${task.title}”?`),
      h('button', { class: 'btn ghost', onclick: () => ((S.confirmTick = null), render()) }, 'Cancel'),
      h('button', { class: 'btn primary', key: `yes-${task.id}`, disabled: busy(), onclick: () => complete(task) }, 'Complete')
    )
  }
  const due = dueLabel(dueKey(task))
  return h(
    'div',
    { class: 'task', key: `task-${task.id}`, onclick: () => openTask(list, task) },
    checkbox(task, () => ((S.confirmTick = task.id), render()), { title: task.repeatFlag ? 'Complete (repeats)' : 'Complete' }),
    h('div', { class: 'text' }, h('div', { class: 'title' }, task.title || 'Untitled')),
    task.content.trim() ? h('span', { class: 'note', title: 'Has a description' }, icon('note')) : null,
    task.repeatFlag ? h('span', { class: 'note', title: 'Repeats' }, icon('repeat')) : null,
    due ? h('span', { class: `due ${due.kind}` }, due.label) : null
  )
}

function doneRow(task) {
  const at = parseDue(task.completedTime)
  return h(
    'div',
    { class: 'task done', key: `done-${task.id}` },
    checkbox(task, () => reopen(task), {
      on: true,
      disabled: task.repeatFlag !== null,
      title: task.repeatFlag ? 'Repeating task: its next date is already open' : 'Mark as not done'
    }),
    h('div', { class: 'text' }, h('div', { class: 'title' }, task.title)),
    at ? h('span', { class: 'due' }, shortDate(at)) : null
  )
}

function completedSection(list) {
  const loaded = S.done && S.done.list === list ? S.done.tasks : null
  const out = [
    h(
      'button',
      {
        class: `section${S.doneOpen ? ' open' : ''}`,
        key: 'completed',
        'aria-expanded': String(S.doneOpen),
        onclick: () => {
          S.doneOpen = !S.doneOpen
          render()
          if (S.doneOpen && !loaded) void loadDone(list)
        }
      },
      icon('chevron'),
      'Completed',
      loaded ? h('span', { class: 'num' }, String(loaded.length)) : null
    )
  ]
  if (!S.doneOpen) return out
  if (!loaded && S.doneFailed)
    out.push(
      h('div', { class: 'hint' }, 'Could not load completed tasks. ', h('button', { onclick: () => loadDone(list) }, 'Retry'))
    )
  else if (!loaded) out.push(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))
  else if (loaded.length === 0) out.push(h('div', { class: 'hint' }, 'Nothing completed in the last 30 days.'))
  else out.push(...loaded.map(doneRow))
  return out
}

function tasksScreen(list) {
  const d = S.data
  if (d && !d.projects.some((p) => p.id === list)) {
    return page([
      h('div', { class: 'bar' }, backButton('Lists', () => go({ screen: 'lists' }))),
      h('div', { class: 'empty' }, 'This list no longer exists. It was closed or deleted in TickTick.')
    ])
  }
  const tasks = tasksOf(list, d?.tasks ?? [])
  const add = h('input', {
    placeholder: 'Add task, press Enter',
    key: 'add',
    'aria-label': 'Add task',
    disabled: busy(),
    onkeydown: (e) => e.key === 'Enter' && addTask(list, e.target)
  })
  return page([
    h('div', { class: 'bar' }, backButton('Lists', () => go({ screen: 'lists' })), h('div', { class: 'spacer' }), refreshButton()),
    h('h1', {}, listName(list), h('span', { class: 'count' }, String(tasks.length))),
    h('label', { class: 'add' }, icon('plus'), add),
    errorBanner(),
    !d
      ? [h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })]
      : tasks.length === 0
        ? h('div', { class: 'empty' }, 'All done. Add a task above.')
        : tasks.map((t) => taskRow(list, t)),
    completedSection(list)
  ])
}

/** A textarea that grows with its text, so the page scrolls, not the field. */
function autoGrow(el) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function taskScreen(list) {
  const task = draftTask()
  const d = S.draft
  const back = () => {
    // Send what is still waiting for the typing pause, then leave.
    void flush()
    S.confirmTick = null
    S.deleteArmed = false
    go({ screen: 'tasks', list })
  }
  if (!task || !d || d.taskId !== S.nav.taskId) {
    return page([
      h('div', { class: 'bar' }, backButton(listName(list), back)),
      h('div', { class: 'empty' }, 'This task is gone. It was completed or deleted.')
    ])
  }
  const due = dueLabel(d.due)
  const p = PRIORITY[Number(d.priority)] ?? PRIORITY[0]

  const dateInput = h('input', {
    type: 'date',
    key: 'due',
    value: d.due,
    'aria-label': 'Due date',
    onchange: (e) => {
      patchDraft({ due: e.target.value }, true)
      render()
    }
  })
  const priorityMenu =
    S.menu === 'priority'
      ? h(
          'div',
          { class: 'menu', onclick: (e) => e.stopPropagation() },
          [5, 3, 1, 0].map((n) =>
            h(
              'button',
              {
                class: String(n) === d.priority ? 'on' : '',
                onclick: () => {
                  S.menu = null
                  patchDraft({ priority: String(n) }, true)
                  render()
                }
              },
              h('span', { class: `flag p-${PRIORITY[n].key}` }, icon('flag')),
              PRIORITY[n].label
            )
          )
        )
      : null

  const title = h('textarea', {
    class: 'ttl',
    key: 'title',
    rows: 1,
    placeholder: 'Title',
    'aria-label': 'Title',
    value: d.title,
    oninput: (e) => {
      autoGrow(e.target)
      patchDraft({ title: e.target.value })
    },
    onkeydown: (e) => {
      // Enter saves and moves to the description, as in TickTick.
      if (e.key === 'Enter') {
        e.preventDefault()
        void flush()
        document.querySelector('[data-k="desc"]')?.focus()
      }
    }
  })
  const desc = h('textarea', {
    class: 'desc',
    key: 'desc',
    placeholder: 'Write something',
    'aria-label': 'Description',
    value: d.content,
    oninput: (e) => {
      autoGrow(e.target)
      patchDraft({ content: e.target.value })
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void flush()
    }
  })
  requestAnimationFrame(() => {
    autoGrow(title)
    autoGrow(desc)
  })

  const asks = []
  if (S.confirmTick === task.id)
    asks.push(
      h(
        'div',
        { class: 'banner ask-box' },
        h('div', { class: 'msg' }, 'Complete this task?'),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'btn primary',
              disabled: busy(),
              onclick: async () => {
                await flush()
                await complete(task)
                go({ screen: 'tasks', list })
              }
            },
            'Complete'
          ),
          h('button', { class: 'btn ghost', onclick: () => ((S.confirmTick = null), render()) }, 'Cancel')
        )
      )
    )
  if (S.deleteArmed)
    asks.push(
      h(
        'div',
        { class: 'banner ask-box del' },
        h('div', { class: 'msg' }, 'Delete this task? It is removed from TickTick for good.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn danger', disabled: busy(), onclick: () => remove(list, task) }, 'Delete'),
          h('button', { class: 'btn ghost', onclick: () => ((S.deleteArmed = false), render()) }, 'Cancel')
        )
      )
    )

  return page(
    [
      h('div', { class: 'bar' }, backButton(listName(list), back)),
      h(
        'div',
        { class: 'detail-bar' },
        checkbox(task, () => ((S.confirmTick = task.id), render())),
        h('span', { class: 'sep' }),
        h(
          'label',
          { class: `chip${due ? ` set ${due.kind}` : ''}`, title: 'Due date' },
          icon('calendar'),
          due ? due.label : 'Due Date',
          dateInput
        ),
        d.due
          ? h(
              'button',
              { class: 'icon-btn', title: 'Clear date', 'aria-label': 'Clear date', onclick: () => (patchDraft({ due: '' }, true), render()) },
              icon('x')
            )
          : null,
        task.repeatFlag ? h('span', { class: 'repeat', title: 'Repeats' }, icon('repeat')) : null,
        h('div', { class: 'spacer', style: 'flex:1' }),
        h(
          'div',
          { class: 'anchor' },
          h(
            'button',
            {
              class: `icon-btn flag p-${p.key}`,
              title: p.label,
              'aria-label': 'Priority',
              onclick: (e) => {
                e.stopPropagation()
                S.menu = S.menu === 'priority' ? null : 'priority'
                render()
              }
            },
            icon('flag')
          ),
          priorityMenu
        )
      ),
      errorBanner(),
      asks,
      title,
      desc
    ],
    [
      h('span', { class: 'grow' }, listName(list), ' · ', h('span', { key: 'save-state', class: S.saveState === 'invalid' || S.saveState === 'failed' ? 'bad' : '' }, SAVE_TEXT[S.saveState])),
      h(
        'button',
        { class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', onclick: () => ((S.deleteArmed = true), render()) },
        icon('trash')
      )
    ]
  )
}

// ---------- render, keeping focus and scroll ----------

const root = document.getElementById('root')

function screen() {
  if (S.auth === null) return page([h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })])
  if (!S.auth.connected) return connectScreen()
  if (S.nav.screen === 'tasks') return tasksScreen(S.nav.list)
  if (S.nav.screen === 'task') return taskScreen(S.nav.list)
  return listsScreen()
}

let lastScreen = ''

function render() {
  const active = document.activeElement
  const key = active && active.dataset ? active.dataset.k : undefined
  const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null
  const scroll = root.querySelector('[data-k="body"]')?.scrollTop ?? 0
  const where = JSON.stringify(S.nav)
  root.replaceChildren(screen())
  const body = root.querySelector('[data-k="body"]')
  // Same screen: keep the scroll; a new screen starts at the top.
  if (body && where === lastScreen) body.scrollTop = scroll
  lastScreen = where
  if (key) {
    const again = root.querySelector(`[data-k="${CSS.escape(key)}"]`)
    if (again && !again.disabled) {
      again.focus()
      if (sel && 'setSelectionRange' in again) {
        try {
          again.setSelectionRange(sel[0], sel[1])
        } catch {}
      }
    }
  }
}

// A click anywhere else closes the priority menu.
document.addEventListener('click', () => {
  if (S.menu) {
    S.menu = null
    render()
  }
})

// ---------- start ----------

orca.plugin.on('auth.changed', (payload) => {
  S.auth = payload
  render()
})
orca.plugin.on('task.upserted', ({ task }) => applyTask(task))
orca.plugin.on('task.removed', ({ id }) => applyRemoved(id))
// Another panel reloaded: take the worker's cached copy (no call to TickTick).
orca.plugin.on('data.reloaded', ({ loadedAt }) => {
  if (S.auth?.connected && S.data?.loadedAt !== loadedAt) void load(false, true)
})

render()
void run(() => request('auth.status')).then((answer) => {
  if (!answer) return
  S.auth = answer
  render()
  if (answer.connected) void load()
})

