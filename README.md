# TickTick for Orca

TickTick in Orca's right sidebar, drawn to look like TickTick. Three screens, one at a time,
with a `←` back button:

1. **Lists**: your projects with their open count (and overdue in red). Connected / Disconnect
   stays at the bottom.
2. **Tasks**: an empty square per task, coloured by priority; it asks "Complete …?" first. Press
   a title to open the task. Type in "Add task" and press Enter. **› Completed** is closed; open
   it for the last 30 days, and press a ticked square to untick.
3. **Task**: a bar with the square, the due date (opens the date picker) and the priority flag;
   then the title and the description, with no boxes: you just type. It saves by itself 2.5 s
   after you stop (Enter in the title, a picked date or priority, and Back save at once). Only
   the fields you touched are sent, so a change made elsewhere meanwhile is kept. Closing the
   panel within 2.5 s of the last key loses that last bit of typing.

Before those, **Connect** asks for a TickTick Open API access token, checks it with TickTick, then
keeps it in the OS keychain (plugin storage when the machine has no keychain).

## How it works

- `panel/index.html`, `panel/app.js`, `panel/style.css`: the screens, plain DOM in Orca's sandboxed
  frame, coloured from the `--orca-*` theme variables. The frame has no network; it asks the worker.
- `panel/logic.js`: dates, ordering and what the task page sends; tested in Node (`src/logic.test.ts`).
- `src/worker.ts`: the only part that calls `https://api.ticktick.com/open/v1`. It runs on the
  machine where the Orca app runs (your desktop), not on an SSH host.
- `src/protocol.ts`: the request and event types both sides share.

TickTick allows **100 calls a minute**. A full load costs one call per list (projects + Inbox);
a tick, add, edit, reopen or delete costs one call and updates the lists in place. Opening
Completed costs one call. Opening the
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
