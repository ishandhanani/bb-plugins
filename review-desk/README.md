# bb-plugin-review-desk

Review GitHub pull requests inside bb: a document-style PR page with the diff, the conversation, inline comment authoring, and a chat with an analyst that has the code in front of it.

## What it does

- **PR factory**: a PR you add goes to **AI review**. A hidden reviewer thread runs round 1 with the code review skills it has, both your own and the repository's (project skills, CLAUDE.md, AGENTS.md), and the server posts the result to GitHub as a COMMENT review headed "Round N AI review": each finding labeled BLOCKER, BUG, PERF, TEST, DESIGN, QUESTION, or NIT, inline on its line, with NITs folded into the body. Each push after that, once the head has sat still for `aiReviewSettleMinutes`, runs a targeted round over what the PR changed since then that also marks earlier findings fixed, open, or obsolete; the factory replies on and resolves its own threads for the ones it closes. The rounds stop when they converge, not after a fixed count: as soon as a round leaves only NITs, or when a push resolves none of the open findings and the round finds nothing new (on your own PR, when the author's agent makes no more progress); `aiReviewMaxRounds` is only a safety cap. Then comes the **Final check**: a reviewer that has never seen the PR (a new thread on `finalCheckModel`, told not to read earlier reviews) reviews all of it, and the reviewer thread, which has the PR's whole history, tries to refute each finding on `verifyModel`, with evidence either way. Only what holds up is posted inline (unsettled ones as QUESTIONs); the refuted ones are folded in the review body with the verifier's evidence. On your own PR the author's agent fixes what held up and the verifier checks each fix, then Babysit; on anyone else's the PR moves to **Human review** and the reviewer thread shows up unread in the sidebar. MLflow gets how many of the fresh reviewer's findings were confirmed, refuted, and unsettled. Your own review moves it on: anything but an approval to **Changes requested** (back to Human review when the author pushes), an approval to **Babysit**, where a small model re-runs flaky CI and hands anything that needs a push or a decision back to you (unread thread, chip on the card). It never edits, pushes, merges, or comments. The brain button on a card starts or retries the next round now; dragging a card into a factory column moves it there, and dragging it to Unreviewed takes it out.
- **Slack bridge**: one channel you pick is the factory's room. **Post to Slack** on a PR page (next to the head sha) gives that PR a thread whose root is its card: title, the stages of its lane with the current one in bold (`AI review › Fixing › *Deslop* › Your review › Babysit`), CI, open threads, and what is happening now, repainted as it moves. Nothing is posted until you ask; **Stop** ends the updates and leaves what is there. The factory's events are replies in the PR's thread: each AI round with a table of its findings, each run of the author's agent as a plan that goes from working to one task per verdict, each babysit action, and hand-offs, which are the only replies that mention you. Talk in a PR's thread and the PR's agent answers there: on your PR the `#N · PR` thread on its branch, on others' the read-only analyst. An @mention or DM anywhere else starts a bb thread in `slackProject` with the Slack thread so far. Every turn from Slack runs on `slackModel`. Several people can be in a thread: each message reaches the agent with its sender's name, side talk not addressed to it is passed with "answer only if it is for you", and the agent may answer `<silent/>`, which posts nothing. Plain words are handled before any model: `(aside) …` is ignored, `mute` / `unmute` silence a thread except for @mentions, `stop` stops the agent, and in a PR thread `babysit`, `fix`, `deslop`, and `review` act on the PR. It uses Socket Mode, so bb needs no public URL; `slack-app-manifest.yaml` creates the app.
- **The board** is the landing page: paste a PR link and it becomes a card under **Unreviewed** (no review has started), **AI review**, **Human review**, **Changes requested** (a reviewer asked for changes), or **Babysit** (approved by you or others: the decision, or any reviewer's latest review; now you watch CI until it merges). Drag a card to hold it elsewhere until GitHub's state changes, then it follows GitHub again. A card shows the title, `owner/repo #N`, the author, when GitHub last saw activity, and chips for what is in the way: checks passed/total (red when one fails), unresolved threads, approvals, reviewers asking for changes, merge conflicts, and your pending comments. A Babysit card leads with CI: a bar of passed checks, the failing checks by name linking to their runs, one verdict chip (merge conflicts, CI failing, CI running, needs a required review, still a draft, or ready to merge) and when the last commit was pushed. Merged and closed PRs leave the columns and fold into a strip under them until you remove them. Click a card for the PR page below. Open PRs are synced with GitHub when the board opens if they are more than ten minutes stale, on **Refresh**, and in the background on the `boardRefresh` cron; a sync skips the git fetch when the head did not move.
- **Open a PR** by URL or `owner/repo#123`. The host entry finds the local checkout among your bb projects (or clones it), fetches the PR head, and keeps a detached worktree under `~/.review-desk/worktrees` on that machine (or `worktreesDir`), outside bb's data dir so the chat and helper threads can run in it.
- **PR page**: state, title, author, base and head branches, then three tabs: **Map** (first and default), **Diff**, and **Comments**. Diff holds the commits and the changed files as cards; files load lazily as you scroll, and viewed marks and a "lines left" counter track progress. Comments holds the description and the discussion (reviews, comments, open threads).
- **Diff** per file with Pierre diffs: split by default (unified on request), long lines wrap instead of scrolling sideways, syntax highlighting from bb's code theme, expandable context, line selection. Every file starts collapsed; **Expand all** opens the unviewed ones.
- **Map** tab: a [diffmap](https://github.com/tanishqkancharla/diffmap) of the PR, a walkthrough with diagrams, call stacks, and code linked to the diff, written by the hidden helper thread with diffmap's own `generate-diffmap` skill (bundled under `skills/`). Written when a PR is added and again at each new head once you have one (`autoMap`); Rewrite at any time. An older map stays on screen, marked stale, while a newer one is written.
- **Commits you can open**: click a commit in the Diff tab's Commits list for its diff against its first parent (position, Older and Newer, full message, GitHub link); shift-click a second commit to diff the range between them. The review remembers the head you last opened it at, marks newer commits "new" with a divider at your last position, and offers "Diff the N new commits since you last looked". Commit views are read-only apart from the chat: select lines to ask about them as they were at that commit (a pill pinned to the sha), `@` a commit by sha or title, and use Comment at head to jump to the same lines in the PR diff.
- **GitHub threads inline**, anchored to their lines, with reply and resolve. Comment cards use the app font, wrap, render `<details>` as collapsibles, and carry chips for the PR author, bots, severity, and finding ids.
- **Simple English**: every GitHub comment (inline threads, conversation comments, review bodies) can flip to a plain rewrite written by a second hidden thread: what the author wants first, then only the facts needed to act, sentences of at most 12 words, words a twelve-year-old knows, code kept byte for byte, at most a third of the length. Each comment has its own **Simple English** / **Original** switch and starts on the original. In the default lazy mode a comment is rewritten the first time you flip it (a few seconds on a fast model); eager mode rewrites every comment as it loads. An edited comment is redone, everything else is served from SQLite.
- **Comments**: select lines and press Comment, or use the gutter button. Comments stay pending until you submit one review from the Info tab as comment, approve, or request changes. Nothing reaches GitHub without that click.
- **Private notes**: comments only you see, shown inline with an amber dashed edge. Two sources: **Find slop and cleanups** (Notes menu above the changes) has the helper read the diff and leave up to 25 notes with kind (slop, cleanup, risk, question), severity, and sometimes a suggested rewrite; and **Keep private** on the comment composer. Each note can be dismissed, promoted to a pending GitHub comment (a suggestion becomes a `suggestion` block), sent to the chat as a pill, or sent to the council. Notes carry a content hash of their line and follow it across pushes; ones whose line is gone are marked stale.
- **Chat with the PR**: the Chat tab hosts one analyst thread per provider, spawned into the PR worktree and read-only by instruction, rendered with bb's own thread view. The first message comes from bb's new-thread composer (pick provider and model there; the environment shown is ignored, the analyst always runs in the PR worktree); later messages go through the thread's own composer. Message actions turn an answer into a pending comment on the selected lines or send it to a Roundtable room.
- **Code pills**: code goes into the chat as @-mention pills that resolve to text when you send, so the transcript stays short and the analyst gets the excerpt. Three ways in: select lines in the diff and press `a` or **Add to chat**; type `@` in the composer to search changed files, commits, GitHub review threads, the PR description, or an explicit `path:10-20`; or pick **Summarize in chat** on a file card. A banner above the composer shows the current diff selection with its own **Add to chat**.
- **Info** tab: checks with a progress bar, reviewers with their state, assignees, labels, and the pending review.

## Layout

- `host-contract.ts` — RPC contract between server and host.
- `host.ts` — runs on the machine with the repository: git worktrees and diffs, `gh` for PR data and review submission.
- `server.ts` — SQLite store (reviews, viewed files, GitHub caches, pending comments, notes, chat seats, maps), RPC for the UI, `bb review-desk` CLI.
- `app.tsx` — the **Reviews** nav panel; fixed tabs **Info** and **Chat**; the composer banner that receives pills.
- `board-spec.ts` — the board's columns and their labels, shared by server and app.
- `factory-spec.ts` — the PR factory's prompts, reply parsing, and the GitHub review body, shared by server and app.
- `slack-client.ts` — Slack Web API calls and the Socket Mode connection, with no SDK.
- `slack-blocks.ts` — the Slack bridge's Block Kit: PR cards and the factory's replies.
- `slack-app-manifest.yaml` — the Slack app the bridge needs.
- `board.tsx` — the board page: columns, cards, drag and drop, the merged-or-closed strip.
- `lib/format.ts` — `timeAgo` and `describeError`, shared by the review page and the board.
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
bb review-desk board
bb review-desk move <reviewId> <unreviewed|ai_review|human_review|changes_requested|babysit|auto>
bb review-desk refresh
bb review-desk factory <start|stop|show|ping|resolve> <reviewId>
bb review-desk ask <reviewId> <text...> [--provider <id>]
bb review-desk map <reviewId> [--rewrite]
```

## Settings

- `defaultProvider` (default `claude-code`): the analyst preselected in Chat and used by the CLI.
- `hideSeatThreads` (default true): keep analyst and helper threads out of the sidebar.
- `autoMap` (default true): write the PR's diffmap when it is added to the board, and again when it is viewed at a new head.
- `helperModel` (default empty): model for the helper thread that writes the map and finds notes; empty uses the project's remembered default, which is what the analyst seats use too.
- `simpleEnglishMode` (default `lazy`): `lazy` rewrites a comment when you flip it, `eager` rewrites every comment as it loads, `off` hides the switches; `bb review-desk simple <reviewId>` queues a whole review in any mode.
- `simpleEnglishProvider` (default empty): provider id for the Simple English thread; empty uses `defaultProvider`. Changing it replaces the review's live Simple English thread on the next batch.
- `simpleEnglishModel` (default empty): model for the Simple English thread; empty uses `helperModel`, then the project's default. A small, fast model is enough, for example `acp-devin` with `swe-1-7-lightning`.
- `simpleEnglishSkill` (default empty): optional file appended to the rewrite prompt as vocabulary help, for example a `simple-english` SKILL.md. Empty uses a short built-in word list. A long rule set makes a fast model paraphrase instead of shorten, so the default is the short list.
- `boardRefresh` (default `*/15 * * * *`): cron (5 fields, server-local time) for syncing the board's open PRs with GitHub in the background; empty turns it off.
- `autoAiReview` (default true): put a PR in the factory when it is added to the board. Rounds post COMMENT reviews under your `gh` login.
- `aiReviewProvider` / `aiReviewModel` (default `claude-code` / `claude-fable-5-1`): the AI reviewer.
- `aiReviewMaxRounds` (default 4): safety cap on AI rounds; the loop normally ends sooner, when a round leaves only nits or makes no progress.
- `finalCheck` (default true): run the final check after the rounds. `finalCheckModel` (default `claude-fable-5-1`): its fresh-context reviewer. `verifyModel` (default `claude-opus-5-5`): its verifier; a different model than the reviewer's catches more of its mistakes. Drag a card into Final check to run one at the current head.
- `aiReviewConcurrency` (default 2): rounds running at once across the board.
- `aiReviewSettleMinutes` (default 10): how long a new head must sit unchanged before the next round. Pushes are noticed on the `boardRefresh` cron.
- `aiReviewSkills` (default empty): skills the reviewer must use on top of the ones it picks; comma separated, `owner/repo=skill` for one repository.
- `aiReviewEmpirical` (default false): let the reviewer run skills that build, launch servers, or run GPU or load tests. Off, it applies them by reading the code.
- `fixerProvider` / `fixerModel` (default `claude-code` / `claude-opus-5-5`): the author's agent on your own PRs, which fixes feedback and merges the base.
- `deslopModel` (default `claude-fable-5-1`; empty uses `fixerModel`): the author's agent's deslop turns, in the same thread.
- `babysitProvider` / `babysitModel` (default `claude-code` / `claude-opus-5-5`): the CI babysitter.
- `babysitMaxPasses` (default 3): babysit passes per head before CI failures are handed to you.
- `slackBotToken` / `slackAppToken` (secrets, default empty): the Slack bridge's bot token (`xoxb-…`) and app-level token (`xapp-…`, `connections:write`). Create the app from `slack-app-manifest.yaml`. The bridge's settings apply live: it connects when both tokens are set and reconnects when any of them change.
- `slackChannel` (default empty): the channel id for the PR threads; invite the bot to it.
- `slackUserId` (default empty): your Slack member id. Hand-offs mention you, and you can steer the agents.
- `slackSteerers` (default `*`): who may steer the agents from Slack: `*` for everyone, or member ids, comma separated; anyone else's messages are context for the next turn.
- `slackModel` (default `claude-opus-5-5`): the model for every agent turn started from Slack.
- `slackProject` (default `proj_personal`): the bb project for conversations started in Slack outside a PR thread.
- `slackApiBase` (default `https://slack.com/api`): change only to test against a fake Slack.
- `slackWebhookUrl` (secret, default empty): a Slack incoming webhook. When set, every hand-off to you (Ready for you, Ready for you again, Needs you) also pings Slack with the PR link and why. `bb review-desk factory ping <reviewId>` sends a test to every configured sink.
- `slackMention` (default empty): put at the start of each ping, for example `<@U0123ABCD>`, so a channel webhook notifies you.
- `eventWebhookUrl` / `eventWebhookSecret` (default empty; the secret goes out as `X-Webhook-Secret`): every hand-off also goes here as JSON: `event` (`ready_for_you`, `ready_again`, `needs_you`, `test`), `headline`, `why`, `pr`, `factory`, and `checks`. Point it at a Devin automation's webhook trigger with a "Message session" action into one long-running Devin session synced to a Slack thread, and Devin relays each event to Slack and answers follow-up questions there.
- Review threads that surface (AI review, babysit) are titled by PR number, `#17712 · Ready for you`, and run in one shared environment per repository named after `threadSection`: a worktree of a tiny local repo under `<worktreesDir>/.groups/` that links each PR worktree as `pr-<number>`. bb folds threads into a folder only when two or more visible ones share a worktree environment, so they appear as a **Review Desk** folder inside the project once there are two.
- `threadSection` (default `Review Desk`): the sidebar section (folder) every thread Review Desk starts goes in, so chats, AI review, and babysit threads do not clutter the project; empty leaves them unsectioned.
- `worktreesDir` (default empty): directory on the repository's machine for the PR worktrees; empty uses `~/.review-desk/worktrees`. Keep it outside bb's data dir, or bb refuses to run the chat and helper threads there. Changing it moves each worktree on its next sync. Removing a PR from the board removes its worktree too, unless it has local changes.
