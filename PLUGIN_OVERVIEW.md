Put several agents on different providers in one group chat and let them argue to a decision.

## What you get

- A **Roundtable** page in the left sidebar with rooms, a shared transcript, and a composer that tags seats.
- One thread per seat, all in the same workspace, created the first time each seat is tagged.
- **One knob, Turns.** Tag one seat and Send: Turns is how many times the agents may relay to each other before you get the floor back. Tag two or more and Discuss: Turns caps a scheduled back-and-forth that ends once everyone agrees.
- **Stance footer**: every reply ends with `STANCE` and `OPEN` lines. Badges show who agrees, who disagrees, and what is still open. `need-info` pauses a discussion until you answer in the room.
- **Read-only by default**: a seat edits files only if you allow it. Pin one working document per room with a single owner, shown in a side tab, plus a bar listing uncommitted workspace changes.
- **Templates** for the two common phases, discuss an idea and implement then review, as editable prompts. The settings panel shows exactly what each seat is told, so nothing about behavior is hidden.
- **Late join** with a briefing written by an existing seat, per-seat compact, reset, and remove.
- A **Roundtable room** action in any thread's side panel that opens or creates the room for that workspace.
- A `bb roundtable` command so agents can read the room and pull each other in mid-turn.

## How it works

Threads on different providers cannot share a session, so the plugin owns the transcript. When a seat is tagged it receives only the messages it has not seen yet, each labeled with its author, plus one instruction line. Its final reply is captured when the thread goes idle, parsed for its footer, and posted back to the room. Rooms and messages live in the plugin's own SQLite database on the BB server.

## For agents

The bundled skill explains the relay, the footer, the file rules, and the `bb roundtable` commands.
