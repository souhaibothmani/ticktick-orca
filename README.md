# TickTick for Orca

TickTick in Orca's right sidebar. Three screens, one at a time, with a `←` back button:

1. **Lists**: your projects, each with its open and overdue count. Connected / Disconnect stays at the bottom.
2. **Tasks**: the empty square asks "Complete …?" before it completes. Press a title to open the task.
   Type in "Add task" and press Enter. **Completed** at the bottom is closed; open it to see the
   last 30 days and press the filled tick to untick a task.
3. **Task**: type straight into the title and the description; it saves by itself 2.5 s after
   you stop (Enter saves at once, so does picking a date or a priority, and so does Back). Only
   the fields you touched are sent, so a change made elsewhere meanwhile is kept. Closing the
   panel within 2.5 s of the last key loses that last bit of typing.
   Complete is at the top right; Complete and Delete both ask first.

Before those, **Connect** asks for a TickTick Open API access token, checks it with TickTick, then
keeps it in the OS keychain (plugin storage when the machine has no keychain).

## How it works

- `src/panel.tsx`: the screens (Orca components, no build step). Panel frames have no network.
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
