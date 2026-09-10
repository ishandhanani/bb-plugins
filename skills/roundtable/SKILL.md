---
name: roundtable
description: Take part in a Roundtable room, a group chat shared by the user and several agents on different providers. Use when your thread was created by the Roundtable plugin, when a message says you are in a room, or when the user asks you to read, post to, or pull another agent into a room with `bb roundtable`.
---

# Roundtable rooms

A room is one shared transcript. Each participant is a separate thread on its own provider, so nothing you see comes from another agent's context. The plugin relays every room message you have not seen yet into your thread, with the author in front of it, and posts your final reply back to the room under your handle.

## Reply format

End every reply with exactly two lines, in this order:

```
STANCE: agree | disagree | need-info | pass
OPEN: none
```

When points are open, put them on numbered lines after `OPEN:`:

```
STANCE: disagree
OPEN:
1. The cache key ignores the tenant id, so two tenants collide.
2. No rollback path if migration 7 fails halfway.
```

- `agree`: you accept the current position with nothing blocking.
- `disagree`: you object. OPEN says exactly what.
- `need-info`: you cannot proceed without an answer from the user. Put the question in OPEN. In a job this pauses the room until the user replies.
- `pass`: nothing to add this turn.

Rounds end early once every participant is at `agree` (or `pass`) with `OPEN: none`.

## Roles

Your intro names your role. Follow its contract:

- planner: own the proposal as numbered decisions with rationale; when revising, lead with "Changes since last version"; answer each finding by number with accept, reject, or defer.
- reviewer: numbered findings, each with severity (blocker, major, minor, nit), the exact target, why, and a concrete fix; verify against the workspace; do not restate the proposal.
- implementer: edit only when the user asks for implementation in the room; list the files first; report what changed and how you verified it.

## Pinned document

If the room pins a document, read it before every reply. Only its owner edits it. Everyone else proposes changes as numbered findings. The owner applies accepted changes and lists what changed.

## Addressing others

Write `@handle` when you want a specific participant to respond. If the user gave the message a hop budget, the addressed participant is relayed to automatically and can answer you. Otherwise use the CLI below.

## Commands

| Command | Effect |
| --- | --- |
| `bb roundtable list` | List rooms with ids and participants. |
| `bb roundtable show <room> [--since <seq>]` | Print the transcript. Use `--since` with the last `#seq` you saw. |
| `bb roundtable say <room> [--to a,b] [--hops N] <message>` | Post. Inside a participant thread you post as that participant. `--to` or `@handle` tags participants so they reply. |
| `bb roundtable ask <room> --to a,b [--synth <handle>] <message>` | Ask several participants in parallel, optionally synthesized by one. |
| `bb roundtable rounds <room> --between a,b [--rounds N] <message>` | Bounded back-and-forth until consensus or the cap. |
| `bb roundtable add <room> <handle>=<provider>[:role] [--brief summary|full|none]` | Add a participant with a briefing. |
| `bb roundtable doc <room> --path <path> [--owner <handle>]` | Pin the working document. |
| `bb roundtable resume|cancel <room>` | Resume a paused job or cancel it. |

Add `--json` when the output drives code.

## Rules

- Write your reply for the room. It is posted verbatim under your handle. Do not restate the relayed messages or describe the relay.
- Be concrete. Disagree with specifics. Agree briefly. Keep it short unless the user asks for detail.
- Do not modify files unless your role or the user allows it. Reading files and running read-only commands to check a claim is encouraged. Every participant shares the same workspace.
- Do not start rounds or ask-all jobs unless the user asked for them.
- Post to a room only through `bb roundtable`. Do not edit the plugin's storage.
