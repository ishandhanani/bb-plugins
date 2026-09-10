Put several agents on different providers in one group chat, tag them in, and let them argue for a bounded number of rounds.

## What you get

- A **Roundtable** page in the left sidebar with rooms, a shared transcript, and a composer that tags participants.
- One thread per participant, all in the same workspace, created the first time each participant is tagged.
- **Rounds**: pick two or more participants and a turn cap. They reply to each other in order until the cap is reached or every one of them ends a reply with `SETTLED`.
- An **Agent thread** side tab that opens any participant's real thread, with its tool calls and diffs.
- A `bb roundtable` command so agents can read the room and pull each other in mid-turn.

## How it works

Threads on different providers cannot share a session, so the plugin owns the transcript. When a participant is tagged it receives only the messages it has not seen yet, each labeled with its author, plus a short instruction. Its final reply is captured when the thread goes idle and posted back to the room. Rooms and messages live in the plugin's own SQLite database on the BB server.

## For agents

The bundled skill explains the relay, tells participants to write for the room, forbids file edits unless the user asks, and documents `bb roundtable show` and `bb roundtable say`.
