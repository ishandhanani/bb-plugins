# bb-plugin-review-desk

Review GitHub pull requests inside bb: a document-style PR page with the diff, the conversation, inline comment authoring, and a chat with an analyst that has the code in front of it.

## What it does

- **Open a PR** by URL or `owner/repo#123`. The host entry finds the local checkout among your bb projects (or clones it), fetches the PR head, and keeps a detached worktree under the plugin's host data directory.
- **PR page**: state, title, author, base and head branches, then Description, Discussion (reviews, comments, open threads), and Commits tabs, then Changes as file cards. Files load lazily as you scroll; viewed marks and a "lines left" counter track progress.
- **Diff** per file with Pierre diffs: unified or split, syntax highlighting from bb's code theme, expandable context, line selection.
- **Brief** tab, first and default: a **slop meter** (0 to 100, a heuristic) from deterministic signals over the diff (AI phrasing, comments that repeat the code, defensive noise, weakened or skipped tests, stubs, commented-out code, duplicated blocks, modules outside the stated scope, description shape, over-commenting), each with the lines it came from; plus a **plain-English brief** written by a hidden helper thread from the diff itself: what the PR does, changes by area, every description claim checked against the code with a verdict, and the helper's own read of how much the PR looks like unedited AI output. Every cited line opens the diff. Written once per head when `autoBrief` is on; Rewrite at any time.
- **GitHub threads inline**, anchored to their lines, with reply and resolve. Comment cards use the app font, wrap, render `<details>` as collapsibles, and carry chips for the PR author, bots, severity, and finding ids.
- **Comments**: select lines and press Comment, or use the gutter button. Comments stay pending until you submit one review from the Info tab as comment, approve, or request changes. Nothing reaches GitHub without that click.
- **Chat with the PR**: the Chat tab hosts one analyst thread per provider, spawned into the PR worktree and read-only by instruction, rendered with bb's own thread view. The first message comes from bb's new-thread composer (pick provider and model there; the environment shown is ignored, the analyst always runs in the PR worktree); later messages go through the thread's own composer. Message actions turn an answer into a pending comment on the selected lines or send it to a Roundtable room.
- **Code pills**: code goes into the chat as @-mention pills that resolve to text when you send, so the transcript stays short and the analyst gets the excerpt. Three ways in: select lines in the diff and press `a` or **Add to chat**; type `@` in the composer to search changed files, changed symbols from the codemap, GitHub review threads, the PR description, or an explicit `path:10-20`; or pick **Summarize in chat** on a file card. A banner above the composer shows the current diff selection with its own **Add to chat**.
- **Codemap**: tree-sitter (Rust, Python, TypeScript, JavaScript, Go, C and C++) diffs symbols across base and head, links references between changed symbols, counts fan-in with `git grep`, orders modules for reading, and ranks hotspots. Regex extraction is the fallback.
- **Info** tab: checks with a progress bar, reviewers with their state, assignees, labels, and the pending review.

## Layout

- `host-contract.ts` — RPC contract between server and host.
- `host.ts` — runs on the machine with the repository: git worktrees and diffs, `gh` for PR data and review submission, tree-sitter codemap.
- `server.ts` — SQLite store (reviews, viewed files, GitHub caches, pending comments, chat seats, codemaps), RPC for the UI, `bb review-desk` CLI.
- `app.tsx` — the **Reviews** nav panel; fixed tabs **Info**, **Chat**, **Codemap**; the composer banner that receives pills.
- `slop.ts` — deterministic slop signals over parsed patches (pure functions, server-side).
- `brief-spec.ts` — the brief the helper thread returns, shared by server and app.
- `mention-ref.ts` — pill identity shared by server and app (what a pill points at, how its id is encoded, its label).
- `skills/review-desk/SKILL.md` — instructions the analyst threads receive.

## Develop

```
npm install
bb plugin install .      # builds server, app, and host bundles and registers the directory
bb plugin reload review-desk
npx tsc -p .
bb plugin logs review-desk
```

Requires `gh` authenticated on the machine that holds the repository.

## CLI

```
bb review-desk open <url | owner/repo#N>
bb review-desk list
bb review-desk ask <reviewId> <text...> [--provider <id>]
bb review-desk codemap <reviewId>
```

## Settings

- `defaultProvider` (default `claude-code`): the analyst preselected in Chat and used by the CLI.
- `hideSeatThreads` (default true): keep analyst and helper threads out of the sidebar.
- `autoBrief` (default true): write the plain-English brief the first time a review is viewed at a new head.
