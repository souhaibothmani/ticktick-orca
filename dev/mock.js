// Stand-in for Orca's frame shell and the plugin worker, for dev/check.mjs only (never shipped:
// the manifest's panel entry is panel/index.html).
const root = document.documentElement
for (const [k, v] of Object.entries({
  '--orca-background': '#1a1a1a', '--orca-foreground': '#e9e9e9', '--orca-muted': '#242424',
  '--orca-muted-foreground': '#8e8e8e', '--orca-border': '#2b2b2b', '--orca-accent': '#262626',
  '--orca-primary': '#4772fa', '--orca-primary-foreground': '#ffffff', '--orca-popover': '#232323',
  '--orca-destructive': '#e5484d', '--orca-radius': '8px',
  '--orca-font-sans': 'Inter, -apple-system, system-ui, sans-serif'
})) root.style.setProperty(k, v)
const day = (o) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+o); return d.toISOString().slice(0,19)+'+0000' }
const t = (id, projectId, title, x = {}) => ({ id, projectId, title, content: '', dueDate: null, isAllDay: true, priority: 0, status: 0, sortOrder: 0, repeatFlag: null, completedTime: null, ...x })
const data = {
  projects: [
    { id: 'p1', name: '🌿VIVO SYSTEMS', color: null }, { id: 'p2', name: '🇧🇪Board Of Innovation', color: null },
    { id: 'p3', name: '🇧🇬VVS Growth', color: null }, { id: 'p4', name: '🧡Finikos', color: null }, { id: 'p5', name: 'General', color: null }
  ],
  tasks: [
    t('a', 'p3', 'nuova implemenazione di "inserimento lead dopo richiesta cliente" -> slack', { content: 'ciao come stai' }),
    t('long', 'p3', 'Long prompt', { content: Array.from({ length: 400 }, (_, i) => 'Line ' + i + ' of a long prompt written by the ticktick skill.').join('\n') }),
    t('b', 'p3', 'Verifica LINK offerta', { dueDate: day(0), priority: 5 }),
    t('c', 'p3', 'Planifichiamo PUNTI DISCUSSIONE', { content: 'x', priority: 3 }),
    t('d', 'p3', 'Manda email sebastien proposta', { dueDate: day(-2) }),
    t('e', 'p3', 'GDPR check', { priority: 1 }),
    t('f', 'p3', 'Registra fathom CS per call allineamento/onboarding', { dueDate: day(2) }),
    t('g', 'p3', 'Onboarding -> migliorare offerta'),
    t('h', 'p3', 'Presentazione onboarding e allinemaneot', { repeatFlag: 'RRULE:FREQ=WEEKLY', dueDate: day(5) }),
    t('i', 'p3', 'Fai video utilizzo piattaforma sales'),
    t('j', 'p3', 'PROCESSI - Rinnovi Tracciare bene chiamate etc'),
    t('k', 'p3', 'Reminder offerte rifiutate / scartati + analisi se l\'offerta va'),
    t('l', 'p3', 'calendario per il lead'),
    ...Array.from({ length: 4 }, (_, i) => t('v' + i, 'p1', 'Vivo task ' + i)),
    ...Array.from({ length: 11 }, (_, i) => t('f' + i, 'p4', 'Finikos task ' + i, i === 0 ? { dueDate: day(-1) } : {}))
  ],
  loadedAt: 1
}
const done = [
  t('z1', 'p3', 'Manda processo email di andrea', { status: 2, completedTime: day(0) }),
  t('z2', 'p3', 'Fausto rispondi su tech', { status: 2, completedTime: day(0) }),
  t('z3', 'p3', 'from zoho to vvsconductor', { status: 2, completedTime: day(-2), repeatFlag: 'RRULE:FREQ=DAILY' })
]
const handlers = {}
const answers = {
  'auth.status': () => ({ connected: location.hash !== '#connect', storedIn: 'keychain' }),
  'data.load': () => data,
  'tasks.completed': () => ({ tasks: done }),
  'task.update': (p) => { const x = data.tasks.find((y) => y.id === p.id); Object.assign(x, p); window.__sent = (window.__sent||[]).concat([p]); return { task: x } },
  'task.create': (p) => ({ task: t('new' + Math.random(), p.projectId, p.title) }),
  'task.complete': () => ({ task: null }),
  'task.reopen': (p) => ({ task: { ...done.find((x) => x.id === p.id), status: 0, completedTime: null } })
}
window.orca = {
  plugin: {
    request: async (name, input) => { await new Promise((r) => setTimeout(r, 30)); return answers[name](input) },
    on: (e, fn) => { (handlers[e] ||= []).push(fn); return { dispose() {} } }
  },
  shell: { openExternal: async () => ({ opened: true }) }
}
