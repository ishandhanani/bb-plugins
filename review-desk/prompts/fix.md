Job: triage and fix the feedback on {{pr}} after {{source}}{{reviewUrl}}. The PR head is {{headSha}}; the merge base is {{baseSha}}.

## Read first

{{skills}}

## Steps

1. Pull every review comment fresh: AI review threads, the NITs and off-diff findings listed in the AI review's body, human reviewers, and bots. Take unresolved threads and conversation comments since the last push.
2. Judge each one on the code at the head, not on the comment's confidence:
   - FIX: it is right and worth changing in this PR. A comment from a human reviewer is FIX unless you can show it is wrong.
   - SKIP: it is wrong, already handled, or out of scope. Say why in one sentence. "Not worth the churn" is not a reason to skip a cost on a request path.
   - ASK: only the author can decide (design intent, product behavior, a trade-off). Say what they need to decide.
3. Fix every FIX item with the smallest change that resolves it, one commit per item (or per group of items that are one change). Before you apply a suggestion from a bot, check that it is right: do not add tests that cannot fail, API with no caller, or work on a request path to satisfy a comment.
4. After each fix, sweep what describes the changed behavior: docs, doc comments, AGENTS.md, test names. A test you add must fail with your fix reverted; check it.
5. Run the narrowest checks that prove each fix: the touched crate's or package's tests, the type checker, the linter. Use the repository's own skills and guidance for how to build and test. Do not run GPU or load tests.
6. Commit, but do not push and do not reply on any thread yet. A separate check reads your commits first; you push after it passes.

Wait for anything you start. If you run a build or a test in the background, wait for it in the foreground until it finishes; do not end your turn while it is still running. Your reply is read as the end of the job.

{{output}}

<!-- @revise -->
The check read your commits and rejected {{count}}:

{{rejections}}

For each rejected commit: change it so the problem is gone, or drop it and change the item's verdict to SKIP or ASK with the reason. The commits are not pushed, so you may amend, reorder, or drop them (git rebase, git commit --amend, git reset). Keep the commits that passed as they are. Do not push and do not reply on threads yet; the check runs once more.

{{output}}

<!-- @publish -->
{{checkLine}}

1. Push once: {{push}}.
2. Reply on each thread you judged: "Fixed in <short sha>: <what changed>" for FIX, the reason for SKIP, and the question for ASK. Resolve the AI review's threads you fixed; leave human reviewers' threads for them to resolve.
3. Do not request reviewers and do not mark the PR ready; the author does that.

{{output}}

<!-- @deslop -->
Job: deslop {{pr}} before the author reviews it. The PR's own changes are git diff {{baseSha}}..HEAD (head {{headSha}}).

Use the deslop skill on that diff: merge duplicate or redundant new types and structures, inline structures and helpers with one use, remove dead paths, defensive noise, and comments a person would not write, and keep behavior exactly. Do not remove a cache, a fast path, or a guard that keeps work off a request path: that changes cost, which is behavior. One cleanup per commit, the narrowest checks after each.

Commit, but do not push yet. A separate check reads your commits first; you push after it passes. If nothing is worth removing, change nothing and say so.

Wait for anything you start: do not end your turn while a build or a test is still running in the background.

Reply with one fenced block tagged ai-fix: { "summary": string, "items": [{ "url": "", "author": "deslop", "verdict": "FIX", "reason": string, "commit": string }], "pushed": false, "head": string }, one item per cleanup commit; head is git rev-parse HEAD.

<!-- @ci -->
Job: CI on {{pr}} fails at head {{headSha}} (merge base {{baseSha}}) because of the PR's own code. The CI babysitter's diagnosis: {{diagnosis}}

Failing checks:
{{failing}}

1. Read the failing jobs' logs (gh run view <run-id> --log-failed, or the job URL) and confirm the cause; the diagnosis may be wrong.
2. Reproduce it with the narrowest local command: the one test file, the type check, the linter. Do not run GPU or load tests; when only a GPU run reproduces it, fix from the log and say so.
3. Fix the cause with the smallest change: the PR's code, or the test when the test is what is wrong. One commit per cause. Leave failures the PR does not cause alone.
4. Re-run the narrow command until it passes. Commit, but do not push yet; a separate check reads your commits first.

Wait for anything you start: do not end your turn while a build or a test is still running in the background.

Report one item per failing check: FIX (with the commit), SKIP (not the PR's to fix; say why), or ASK.

{{output}}
