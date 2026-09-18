# bb-plugin-review-desk

Review GitHub pull requests inside bb: a document-style PR page with the diff, the conversation, inline comment authoring, and a chat with an analyst that has the code in front of it.

## What it does

- **Open a PR** by URL or `owner/repo#123`. The host entry finds the local checkout among your bb projects (or clones it), fetches the PR head, and keeps a detached worktree under the plugin's host data directory.
- **PR page**: state, title, author, base and head branches, then Description, Discussion (reviews, comments, open threads), and Commits tabs, then Changes as file cards. Files load lazily as you scroll; viewed marks and a "lines left" counter track progress.
- **Diff** per file with Pierre diffs: unified or split, syntax highlighting from bb's code theme, expandable context, line selection.
- **Brief** tab, first and default: a **slop meter** (0 to 100, a heuristic) from deterministic signals over the diff (AI phrasing, comments that repeat the code, defensive noise, weakened or skipped tests, stubs, commented-out code, duplicated blocks, modules outside the stated scope, description shape, over-commenting), each with the lines it came from; plus a **plain-English brief** written by a hidden helper thread from the diff itself: what the PR does, changes by area, every description claim checked against the code with a verdict, and the helper's own read of how much the PR looks like unedited AI output. Every cited line opens the diff. Written once per head when `autoBrief` is on; Rewrite at any time.
- **Commits you can open**: click a commit in the Commits tab for its diff against its first parent (position, Older and Newer, full message, GitHub link); shift-click a second commit to diff the range between them. The review remembers the head you last opened it at, marks newer commits "new" with a divider at your last position, and offers "Diff the N new commits since you last looked". Commit views are read-only apart from the chat: select lines to ask about them as they were at that commit (a pill pinned to the sha), `@` a commit by sha or title, and use Comment at head to jump to the same lines in the PR diff.
- **GitHub threads inline**, anchored to their lines, with reply and resolve. Comment cards use the app font, wrap, render `<details>` as collapsibles, and carry chips for the PR author, bots, severity, and finding ids.
- **Simple English**: every GitHub comment (inline threads, conversation comments, review bodies) can flip to a plain rewrite written by a second hidden thread: what the author wants first, then only the facts needed to act, sentences of at most 12 words, words a twelve-year-old knows, code kept byte for byte, at most a third of the length. Each comment has its own **Simple English** / **Original** switch; the top-bar toggle sets which side comments start on. In the default lazy mode a comment is rewritten the first time you flip it (a few seconds on a fast model); eager mode rewrites every comment as it loads. An edited comment is redone, everything else is served from SQLite.
- **Comments**: select lines and press Comment, or use the gutter button. Comments stay pending until you submit one review from the Info tab as comment, approve, or request changes. Nothing reaches GitHub without that click.
- **Private notes**: comments only you see, shown inline with an amber dashed edge. Three sources: any slop signal can be shown as notes on its lines from the Brief tab; **Find slop and cleanups** (Notes menu above the changes) has the helper read the diff and leave up to 25 notes with kind (slop, cleanup, risk, question), severity, and sometimes a suggested rewrite; and **Keep private** on the comment composer. Each note can be dismissed, promoted to a pending GitHub comment (a suggestion becomes a `suggestion` block), sent to the chat as a pill, or sent to the council. Notes carry a content hash of their line and follow it across pushes; ones whose line is gone are marked stale.
- **Chat with the PR**: the Chat tab hosts one analyst thread per provider, spawned into the PR worktree and read-only by instruction, rendered with bb's own thread view. The first message comes from bb's new-thread composer (pick provider and model there; the environment shown is ignored, the analyst always runs in the PR worktree); later messages go through the thread's own composer. Message actions turn an answer into a pending comment on the selected lines or send it to a Roundtable room.
- **Code pills**: code goes into the chat as @-mention pills that resolve to text when you send, so the transcript stays short and the analyst gets the excerpt. Three ways in: select lines in the diff and press `a` or **Add to chat**; type `@` in the composer to search changed files, changed symbols from the codemap, GitHub review threads, the PR description, or an explicit `path:10-20`; or pick **Summarize in chat** on a file card. A banner above the composer shows the current diff selection with its own **Add to chat**.
- **Codemap**: your map through the PR, in two layers. The base is deterministic: tree-sitter (Rust, Python, TypeScript, JavaScript, Go, C and C++) diffs symbols across base and head, links references between changed symbols, counts fan-in with `git grep`, tags each file's role (code, tests, docs, config, generated), orders modules by dependency with tests, config, and docs after the code, and ranks hotspots (test code counts a quarter). Regex extraction is the fallback. On top sits a **guide** the helper writes from the diff with the codemap as orientation: **What is going on** (the gist, the shape of the change, what to hold in mind), **How it runs** (the runtime path through the changed code as hops that jump to their line), **Reading order** (steps with a reason each), and one line per changed file saying what it does in this PR, with a role and a skim flag for mechanical changes. The Changes list follows the guide (**Guide order**, the default, with a header per step; **Path order** to switch) and every file card shows its line. Written once per head when `autoGuide` is on, queued behind the brief; Rewrite at any time from the Codemap tab.
- **Info** tab: checks with a progress bar, reviewers with their state, assignees, labels, and the pending review.

## Layout

- `host-contract.ts` — RPC contract between server and host.
- `host.ts` — runs on the machine with the repository: git worktrees and diffs, `gh` for PR data and review submission, tree-sitter codemap.
- `server.ts` — SQLite store (reviews, viewed files, GitHub caches, pending comments, chat seats, codemaps), RPC for the UI, `bb review-desk` CLI.
- `app.tsx` — the **Reviews** nav panel; fixed tabs **Info**, **Chat**, **Codemap**; the composer banner that receives pills.
- `slop.ts` — deterministic slop signals over parsed patches (pure functions, server-side).
- `brief-spec.ts` — the brief the helper thread returns, shared by server and app.
- `guide-spec.ts` — the guide over the codemap the helper thread returns, shared by server and app.
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
bb review-desk guide <reviewId> [--rewrite]
```

## Settings

- `defaultProvider` (default `claude-code`): the analyst preselected in Chat and used by the CLI.
- `hideSeatThreads` (default true): keep analyst and helper threads out of the sidebar.
- `autoBrief` (default true): write the plain-English brief the first time a review is viewed at a new head.
- `autoGuide` (default true): write the codemap guide the first time a review is viewed at a new head. The helper runs one job at a time, so the guide waits for the brief.
- `helperModel` (default empty): model for the helper thread that writes the brief and the guide and finds notes; empty uses the project's remembered default, which is what the analyst seats use too.
- `simpleEnglishMode` (default `lazy`): `lazy` rewrites a comment when you flip it, `eager` rewrites every comment as it loads, `off` hides the switches; `bb review-desk simple <reviewId>` queues a whole review in any mode.
- `simpleEnglishProvider` (default empty): provider id for the Simple English thread; empty uses `defaultProvider`. Changing it replaces the review's live Simple English thread on the next batch.
- `simpleEnglishModel` (default empty): model for the Simple English thread; empty uses `helperModel`, then the project's default. A small, fast model is enough, for example `acp-devin` with `swe-1-7-lightning`.
- `simpleEnglishSkill` (default empty): optional file appended to the rewrite prompt as vocabulary help, for example a `simple-english` SKILL.md. Empty uses a short built-in word list. A long rule set makes a fast model paraphrase instead of shorten, so the default is the short list.
