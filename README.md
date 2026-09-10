# bb-plugin-review-desk

Review GitHub pull requests inside bb with an online-style diff, inline GitHub threads, comment authoring, ask-AI on any selection, a tree-sitter codemap, and analysis passes whose findings anchor to file:line.

## What it does

- **Open a PR** by URL or `owner/repo#123`. The host entry finds the local checkout of that repository among bb projects (or clones it), fetches the PR head, and keeps a detached worktree under the plugin's host data directory.
- **Read the diff** per file with Pierre diffs: unified or split, syntax highlighting from bb's code theme, expandable context, sticky file headers, viewed marks, a filterable file rail.
- **GitHub threads inline**, anchored to their lines, with resolved and outdated state, reply, and resolve. The Review tab shows the PR description, checks, prior reviews, and the conversation.
- **Author comments**: select lines, press Comment (or the gutter button), write Markdown. Comments stay pending until you submit one review from the Review tab as COMMENT, APPROVE, or REQUEST_CHANGES. Nothing reaches GitHub without that click.
- **Ask AI about a selection**: Explain, Why changed, Risks, Suggest fix, or a free question. Each review gets one hidden analyst thread per provider, spawned into the PR worktree, read-only by instruction. Answers become notes anchored to the selection; findings inside a fenced `findings` block become individual notes with severity and line. Notes can be turned into pending comments or sent to a Roundtable room.
- **Passes**: Summary, Risk review, Perf review, Slop review, Test gaps, run against the whole diff from the AI notes tab.
- **Codemap**: tree-sitter (Rust, Python, TypeScript, JavaScript, Go, C and C++) parses the base and head of every changed file, diffs symbols, links references between changed symbols, counts fan-in with `git grep`, orders modules for reading, and ranks hotspots. Regex extraction is the fallback for other languages.

## Layout

- `host-contract.ts` — RPC contract between server and host.
- `host.ts` — runs on the machine with the repository: git worktrees and diffs, `gh` for PR data and review submission, tree-sitter codemap.
- `server.ts` — SQLite store (reviews, viewed files, GitHub caches, AI notes, pending comments, requests, codemaps), AI seats, RPC for the UI, `bb review-desk` CLI.
- `app.tsx` — the **Reviews** nav panel with the diff column and file rail; fixed tabs **Review**, **AI notes**, **Codemap**.
- `skills/review-desk/SKILL.md` — instructions the analyst threads receive.

## Develop

```
npm install
bb plugin install .      # builds server, app, and host bundles and registers the directory
bb plugin reload review-desk
npx tsc -p .
bb plugin logs review-desk
```

Requires `gh` authenticated on the machine that holds the repository. The tree-sitter grammars come from `@vscode/tree-sitter-wasm` in `node_modules`; the server passes that directory to the host.

## CLI

```
bb review-desk open <url | owner/repo#N>
bb review-desk list
bb review-desk pass <reviewId> <summary|risk|perf|slop|tests> [--provider <id>]
bb review-desk notes <reviewId>
bb review-desk codemap <reviewId>
```

## Settings

- `defaultProvider` (default `claude-code`): the analyst provider preselected in the UI and used by the CLI.
- `hideSeatThreads` (default true): keep analyst threads out of the sidebar.
