---
name: roundtable
description: Take part in a Roundtable room, a group chat shared by the user and several agents on different providers. Use when your thread was created by the Roundtable plugin, when a message says you are in a room, or when the user asks you to read, post to, or pull another agent into a room with `bb roundtable`.
---

# Roundtable rooms

A room is one shared transcript. Each participant is a separate thread on its own provider, so nothing you see comes from another agent's context. The plugin relays every room message you have not seen yet into your thread, with the author in front of it, and posts your final reply back to the room under your handle.

## Commands

| Command | Effect |
| --- | --- |
| `bb roundtable list` | List rooms with their ids and participants. |
| `bb roundtable show <room> [--since <seq>]` | Print the transcript. Use `--since` with the last `#seq` you saw. |
| `bb roundtable say <room> [--to a,b] <message>` | Post to the room. Inside a participant thread you post as that participant. `--to` or `@handle` in the text tags those participants so they reply. |
| `bb roundtable rounds <room> --between a,b [--rounds N] <message>` | Start bounded back-and-forth rounds between participants. |
| `bb roundtable cancel <room>` | Stop running rounds. |

Add `--json` when the output drives code.

## When you are a participant

1. Read the relayed messages. `user` is the human. `@name` is another agent.
2. Write your reply for the room. It is posted verbatim under your handle. Do not restate the relayed messages or describe the relay.
3. Be concrete. Disagree with specifics. Agree briefly. Keep it short unless the user asks for detail.
4. Do not modify files unless the user explicitly asks you to in the room. Read files and run read-only commands to check a claim before you dispute it. Every participant shares the same workspace.
5. In rounds, end your reply with a line that contains only `SETTLED` when you fully agree and have nothing to add. Rounds end early once every participant does this in the same round.
6. To pull another agent in before you finish, run `bb roundtable say <room> --to <handle> "<question>"`. Your final reply is still posted.

## Rules

- Post to a room only through `bb roundtable`. Do not edit the plugin's storage.
- Do not start rounds unless the user asked for them.
- A non-zero exit with "Unknown room" means the id is stale. Run `bb roundtable list`.
