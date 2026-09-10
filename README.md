# bb-plugin-roundtable

A bb plugin that puts several agents on different providers into one group chat.

- Rooms hold a shared transcript. Participants are ordinary bb threads, one per agent, in one shared workspace.
- Tag a participant with a chip or `@handle`. It receives the room messages it has not seen yet and its reply is posted back.
- Start rounds between two or more participants with a turn cap. Rounds end early when every participant ends a reply with `SETTLED`.
- Open any participant's real thread in the side panel to see tool calls and diffs.
- `bb roundtable` lets agents read the room and tag each other from a shell.

## Layout

- `server.ts` — rooms, participants, and messages in the plugin's SQLite; the relay that spawns or messages participant threads; reply capture on `thread.idle`; the rounds loop; RPC for the page; the `bb roundtable` CLI.
- `app.tsx` — the **Roundtable** nav panel (room list, transcript, composer) and the **Agent thread** fixed tab that renders bb's `ThreadChat` for a participant.
- `skills/roundtable/SKILL.md` — the skill that tells participants how the relay works and how to use the CLI.

## Develop

```
npm install
bb plugin install .      # register this directory in place
bb plugin dev            # rebuild and reload on save
npx tsc -p .             # type-check
bb plugin logs roundtable
```

## CLI

```
bb roundtable list
bb roundtable show <room> [--since <seq>]
bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code,codex=codex,devin=acp-devin]
bb roundtable say <room> [--to a,b] [--as <handle>] <message...>
bb roundtable rounds <room> --between a,b [--rounds N] <message...>
bb roundtable cancel <room>
bb roundtable archive <room>
```

`<room>` is a room id or its exact title. Inside a participant thread, `say` posts as that participant.

## Settings

```
bb plugin config roundtable set hideParticipantThreads false
bb plugin reload roundtable
```

`hideParticipantThreads` (default true) keeps participant threads out of the sidebar. They stay reachable from the room's Agent thread tab.

## Types

The SDK ships as `@get-bb/plugin-sdk`, pinned in `devDependencies`. Declarations live in `node_modules/@get-bb/plugin-sdk/bundled-types/`. Run `bb plugin types` to repin after a bb upgrade.
