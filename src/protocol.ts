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
    /** `repeats`: read the task back, it stays open with its next date. Answers that task, or null
     *  when it is done (or the read-back failed: the next date shows on the next reload). */
    'task.complete': { input: TaskRef & { repeats?: boolean }; output: { task: TickTask | null } }
    /** Marks a completed task as open again. */
    'task.reopen': { input: TaskRef; output: { task: TickTask } }
    'task.delete': { input: TaskRef; output: { ok: true } }
    /** Tasks of one list completed in the last 30 days, newest first. One call. */
    'tasks.completed': { input: { projectId: string }; output: { tasks: TickTask[] } }
  }
  interface PluginPanelEvents {
    /** After a full reload; panels fetch the cached copy with data.load (a post is capped at 256 KiB). */
    'data.reloaded': { loadedAt: number }
    /** A task was created, edited, reopened, or moved to its next date. */
    'task.upserted': { task: TickTask }
    /** A task was completed, deleted, or found gone in TickTick. */
    'task.removed': { id: string }
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
  /** Set on repeating tasks, e.g. RRULE:FREQ=DAILY;INTERVAL=1. */
  repeatFlag: string | null
  /** When it was completed; null while open. */
  completedTime: string | null
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
