// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// so no scenario calls TickTick.
import { defineCheck } from 'orca/testing'

const project = { id: 'p1', name: '🧡Finikos', color: '#FFAC38' }
const tasks = Array.from({ length: 40 }, (_, i) => ({
  id: `t${i}`,
  projectId: 'p1',
  title: `Task number ${i + 1} with a title long enough to wrap in a narrow panel`,
  content: '',
  dueDate: i % 3 === 0 ? '2026-11-20T23:00:00.000+0000' : null,
  isAllDay: true,
  priority: [0, 1, 3, 5][i % 4],
  status: 0,
  sortOrder: i,
  repeatFlag: null,
  completedTime: null
}))
const connected = {
  'auth.status': { connected: true, storedIn: 'keychain' as const },
  'data.load': { projects: [project, { id: 'p2', name: '🇧🇬VVS Growth', color: null }], tasks, loadedAt: 1 }
}

export default defineCheck({
  // No token stored: the Connect screen.
  fresh: { requests: { 'auth.status': { connected: false, storedIn: null } } },
  // The lists, with Connected / Disconnect at the bottom.
  lists: { requests: connected },
  // A long list: the tasks scroll, the page does not grow past the panel.
  longList: { requests: connected, persisted: { plugin: { nav: { screen: 'tasks', list: 'p1' } } } }
})
