// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

declare module 'orca' {
  interface PluginRequests {
    /** Whether a TickTick token is stored. */
    'auth.status': { output: AuthStatus }
    /** Checks the token against TickTick, then stores it. */
    'auth.connect': { input: { token: string }; output: AuthStatus }
    /** Forgets the stored token. */
    'auth.disconnect': { output: AuthStatus }
    /** Every project and every open task. `fresh` skips the short cache. */
    'data.load': { input: { fresh?: boolean }; output: TickData }
    /** Creates a task. No projectId = Inbox. */
    'task.create': { input: TaskDraft; output: { task: TickTask } }
    /** Changes title, content, due date or priority of a task. */
    'task.update': { input: TaskPatch; output: { task: TickTask } }
    'task.complete': { input: TaskRef; output: { ok: true } }
    /** Marks a completed task as open again. */
    'task.reopen': { input: TaskRef; output: { ok: true } }
    'task.delete': { input: TaskRef; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after any change, so a second panel stays in step. */
    'data.changed': TickData
    'auth.changed': AuthStatus
  }
}

export type AuthStatus = { connected: boolean; storedIn: 'keychain' | 'storage' | null }

export type TickProject = { id: string; name: string; color: string | null }

export type TickTask = {
  id: string
  projectId: string
  title: string
  content: string
  /** ISO string as TickTick sends it, e.g. 2026-11-26T23:00:00.000+0000. */
  dueDate: string | null
  isAllDay: boolean
  /** 0 none, 1 low, 3 medium, 5 high. */
  priority: number
  /** 0 open, 2 completed. */
  status: number
  sortOrder: number
}

export type TickData = { projects: TickProject[]; tasks: TickTask[]; loadedAt: number }

export type TaskRef = { id: string; projectId: string }

export type TaskDraft = {
  title: string
  projectId?: string
  dueDate?: string | null
  isAllDay?: boolean
  timeZone?: string
  priority?: number
}

export type TaskPatch = TaskRef & {
  title?: string
  content?: string
  dueDate?: string | null
  isAllDay?: boolean
  timeZone?: string
  priority?: number
}
