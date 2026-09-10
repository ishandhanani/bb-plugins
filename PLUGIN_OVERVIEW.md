Put several agents on different providers in one group chat, give each a role, and let them argue to a decision.

## What you get

- A **Roundtable** page in the left sidebar with rooms, a shared transcript, and a composer that tags participants.
- One thread per participant, all in the same workspace, created the first time each participant is tagged.
- **Hop budget**: a tagged reply that addresses another participant relays to them automatically, up to the number of hops you allow.
- **Stance footer**: every reply ends with `STANCE` and `OPEN` lines. Badges show who agrees, who disagrees, and what is still open. `need-info` pauses a job until you answer in the room.
- **Roles**: planner, reviewer, implementer, or custom, each with a reply contract the agent must follow.
- **Pinned document**: one working file per room with a single edit owner, shown in a side tab, plus a bar listing uncommitted workspace changes.
- **Rounds** that hand the turn to whoever was addressed and end once everyone is at agree with nothing open.
- **Ask all** for independent answers in parallel, with an optional synthesis turn.
- **Late join** with a briefing written by an existing participant, per-seat compact, reset, and remove.
- A **Roundtable room** action in any thread's side panel that opens or creates the room for that workspace.
- A `bb roundtable` command so agents can read the room and pull each other in mid-turn.

## How it works

Threads on different providers cannot share a session, so the plugin owns the transcript. When a participant is tagged it receives only the messages it has not seen yet, each labeled with its author, plus a short instruction. Its final reply is captured when the thread goes idle, parsed for its footer, and posted back to the room. Rooms and messages live in the plugin's own SQLite database on the BB server.

## For agents

The bundled skill explains the relay, the footer, the role contracts, the pinned document rules, and the `bb roundtable` commands.
