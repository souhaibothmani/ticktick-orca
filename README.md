# TickTick for Orca

TickTick in Orca's right sidebar. Four screens, one at a time:

1. **Connect**: paste a TickTick Open API access token. The plugin checks it with TickTick, then
   keeps it in the OS keychain (plugin storage when the machine has no keychain).
2. **Lists**: Today, Next 7 Days, Inbox, then your projects, each with its open-task count.
3. **Tasks**: tick a task to complete it (Undo appears), add a task with Enter, open a task with the arrow.
4. **Task detail**: title, due date (Today / Tomorrow / Next week / No date), priority,
   description, Complete, Delete (press twice). `← Back` returns to the list.

Today = due today or overdue. Next 7 Days = due within 7 days or overdue. A task added from
Today or Next 7 Days goes to the Inbox, due today.

## How it works

- `src/panel.tsx`: the screens (Orca components, no build step). Panel frames have no network.
- `src/worker.ts`: the only part that calls `https://api.ticktick.com/open/v1`. It runs on the
  machine where the Orca app runs (your desktop), not on an SSH host.
- `src/protocol.ts`: the request and event types both sides share.

TickTick allows **100 calls a minute**. A full load costs one call per list (projects + Inbox);
a tick, add, edit, reopen or delete costs one call and updates the lists in place. Opening the
panel again within 30 s reuses the last load.

## Token

If you already use the TickTick MCP, copy `TICKTICK_ACCESS_TOKEN` from its `.env`. Otherwise
create an app at https://developer.ticktick.com/manage and run its OAuth flow once.

## Develop

```sh
orca plugin test .         # panel + worker tests, fake TickTick
orca plugin check .        # renders the Connect screen
orca plugin validate .
orca plugin dev watch .    # load into Orca, reload on save
```
