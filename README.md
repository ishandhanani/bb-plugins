# bb-plugin-roundtable

A bb plugin that puts several agents on different providers into one group chat and drives them to a decision.

- Rooms hold a shared transcript. Participants are ordinary bb threads, one per agent, in one shared workspace.
- Tag a participant with a chip or `@handle`. It receives the room messages it has not seen yet and its reply is posted back.
- Give the message a hop budget and the agents relay to each other when a reply addresses another participant.
- Every reply ends with a `STANCE: agree | disagree | need-info | pass` line and an `OPEN:` list. `need-info` pauses a job until you answer.
- Seats have roles (planner, reviewer, implementer, custom) with reply contracts.
- Pin one working document per room. Only its owner edits it. A side tab shows it. A bar lists uncommitted workspace changes.
- Rounds hand the turn to whoever was addressed and end once everyone agrees with nothing open. Ask-all fans a question out in parallel with an optional synthesis.
- Add a participant later with a briefing written by an existing one. Compact, reset, or remove any seat.
- Any thread's side panel has a **Roundtable room** action that opens or creates the room for that workspace.

## Layout

- `server.ts` — SQLite store; relay with hop budget; footer parsing; role contracts; jobs (rounds, ask-all) with pause and resume; briefings; document read and create; workspace diff; RPC; the `bb roundtable` CLI.
- `app.tsx` — the **Roundtable** nav panel, the **Agent thread** and **Document** fixed tabs, and the thread panel action.
- `skills/roundtable/SKILL.md` — the skill participants get.

## Develop

```
npm install
bb plugin install .      # register this directory in place
bb plugin dev            # rebuild and reload on save
npx tsc -p .             # type-check
bb plugin logs roundtable
```

Schema changes are append-only in `MIGRATIONS`. To start over, disable the plugin, delete `<dataDir>/plugins/roundtable/data.db`, and enable it again.

## CLI

```
bb roundtable list
bb roundtable show <room> [--since <seq>]
bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code:planner,codex=codex:reviewer] [--doc <path> --owner <handle>] [--hops N]
bb roundtable say <room> [--to a,b] [--hops N] [--as <handle>] <message...>
bb roundtable ask <room> --to a,b [--synth <handle>] <message...>
bb roundtable rounds <room> --between a,b [--rounds N] <message...>
bb roundtable add <room> <handle>=<provider>[:role] [--brief full|summary|none] [--summarizer <handle>]
bb roundtable doc <room> --path <path> [--owner <handle>]
bb roundtable compact|reset|remove <room> <handle>
bb roundtable resume|cancel|archive <room>
```

`<room>` is a room id or its exact title. Inside a participant thread, `say` posts as that participant and inherits what is left of its hop budget.

## Settings

```
bb plugin config roundtable set hideParticipantThreads false
bb plugin reload roundtable
```

`hideParticipantThreads` (default true) keeps participant threads out of the sidebar. They stay reachable from the room's Agent thread tab.
