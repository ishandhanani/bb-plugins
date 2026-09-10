# bb-plugin-roundtable

A bb plugin that puts several agents on different providers into one group chat and drives them to a decision.

- Rooms hold a shared transcript. Seats are ordinary bb threads, one per agent, in one shared workspace.
- Tag a seat with a chip or `@handle`. It receives the room messages it has not seen yet and its reply is posted back. Tag several and Send, and they answer in parallel.
- **Turns** is the one knob. On Send it is how many times the tagged agents may relay to each other before you get the floor back. On Discuss it is the cap on a scheduled back-and-forth that ends once everyone agrees.
- Every reply ends with a `STANCE: agree | disagree | need-info | pass` line and an `OPEN:` list. `need-info` pauses a discussion until you answer.
- Each seat is read-only unless you mark it "may edit files". Pin one working document per room and pick its owner. A side tab shows it. A bar lists uncommitted workspace changes.
- Templates fill the composer with an editable prompt for the two common phases: discuss an idea, implement the plan, review the changes. Nothing about behavior is hidden; the settings panel shows exactly what each seat is told.
- Add a seat later with a briefing written by an existing one. Compact, reset, or remove any seat.
- Any thread's side panel has a **Roundtable room** action that opens or creates the room for that workspace.

## Layout

- `server.ts` — SQLite store; relay with the turns allowance; footer parsing; the discussion job with pause and resume; briefings; document read and create; workspace diff; RPC; the `bb roundtable` CLI.
- `app.tsx` — the **Roundtable** nav panel, the **Agent thread** and **Document** fixed tabs, and the thread panel action.
- `skills/roundtable/SKILL.md` — the skill seats get.

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
bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code,codex=codex,devin=acp-devin:edit] [--doc <path> --owner <handle>] [--turns N]
bb roundtable say <room> [--to a,b] [--turns N] [--as <handle>] <message...>
bb roundtable discuss <room> --between a,b [--turns N] <message...>
bb roundtable add <room> <handle>=<provider>[=model][:edit] [--brief full|summary|none] [--summarizer <handle>]
bb roundtable doc <room> --path <path> [--owner <handle>]
bb roundtable intro <room> <handle>
bb roundtable compact|reset|remove <room> <handle>
bb roundtable resume|cancel|archive <room>
```

`<room>` is a room id or its exact title. Inside a participant thread, `say` posts as that participant and inherits what is left of its turns allowance.

## Settings

```
bb plugin config roundtable set hideParticipantThreads false
bb plugin reload roundtable
```

`hideParticipantThreads` (default true) keeps participant threads out of the sidebar. They stay reachable from the room's Agent thread tab.
