{{header}}

## Read first

{{skills}}

Read every file in this list before you read the diff. They are the review rules: the author's own review skills from this machine, and the repository's skills and AGENTS.md files from its latest default branch (not from the PR branch). Skip a skill only when it is about a language or a subsystem the diff does not touch. Put the name of each one you read in "read".

## Scope

{{scope}}

## How to review

- Report every finding the code supports. Do not drop a finding because it is small, hard to measure, or a matter of taste: give it the label NIT. Nothing is filtered after you; every finding is posted to the pull request.
- Where the skills above set a higher bar for what is worth reporting, ignore that bar and keep their checks. Use the labels below for how much a finding matters.
{{procedures}}
{{empirical}}

## Output

{{output}}

<!-- @scope-first -->
Round {{round}}: review the whole pull request. Full diff: git diff {{baseSha}} {{headSha}}.

<!-- @scope-full -->
Round {{round}}: a whole-PR pass with fresh eyes, the last one before the author is told the PR is ready. You have not seen this PR before. Review all of it, not what changed lately. Full diff: git diff {{baseSha}} {{headSha}}.

Earlier rounds raised the findings below, and they are still open. Do not raise them again. For each, decide fixed, open, or obsolete from the code at this head, and say why in note.

{{prior}}

<!-- @scope-delta -->
Round {{round}}: a targeted round over what the PR changed since the previous round, which reviewed head {{prevHead}} (merge base {{prevBase}}). That is the difference between the PR's diff then (git diff {{prevBase}} {{prevHead}}) and now (git diff {{baseSha}} {{headSha}}), not git diff {{prevHead}} {{headSha}}, which also carries everything merged in from {{baseRef}}. Compare the two per file, for example diff <(git diff {{prevBase}} {{prevHead}} -- <path>) <(git diff {{baseSha}} {{headSha}} -- <path>). The PR's own new commits, with merges from {{baseRef}} shown as one line each: git log --first-parent --oneline {{prevHead}}..{{headSha}} (after a rebase, git range-diff {{prevBase}}..{{prevHead}} {{baseSha}}..{{headSha}}).

Open findings from earlier rounds:

{{prior}}

Tasks:
1. For every open finding above, NITs included, decide fixed, open, or obsolete (the code is gone, or the author's reply in a thread shows it is not a problem; say why in note). Check the code at the new head, not the author's claim. Each one you mark fixed or obsolete gets a reply with your note and its thread is closed, so the note should say what changed in one sentence.
2. Review what changed since the previous round, with the whole PR as context: bugs the fixes introduce, regressions, and new code. New commits are often fixes for review comments: check that each one fixes what was asked, adds no work on a request path, adds nothing unused, and leaves no doc or test describing the old behavior. Do not raise again what is listed above, and do not raise new findings on code the new commits did not touch unless they make it wrong.

<!-- @empirical-on -->
- A skill that reviews empirically (builds, launches servers, runs GPU or load tests) may be run when the change warrants it.

<!-- @empirical-off -->
- Skills that build the project, launch servers, or run GPU or load tests: apply their criteria by reading the code; do not run heavy workloads in a review turn. When a finding can only be settled by running something, say what in its body.

<!-- @procedures -->
- A diff does not show everything. Do these four things on every round:
  1. Follow new callers into old code. For each call the diff adds into code it does not change, open the callee. Ask what it costs at production scale, and how the existing callers configure it: thread counts, pool sizes, limits, timeouts. Unchanged code that a new path makes load-bearing is in scope.
  2. Compare with the sibling path. When the diff adds a second path that does what an existing one does (another engine, transport, protocol, binding, or entry point), list what the existing path sets and handles, and check each item on the new path: config knobs, limits, status codes, keepalives, cancellation, metrics.
  3. Check the claims. Docs, doc comments, AGENTS.md, test names, and the PR description must describe the code at this head. A new test must fail without the change it covers; when you cannot tell from reading, say so in the finding.
     A claim that says every, all, always, or only, or that promises a callback, a wake, or a re-ask on an event, covers more than the diff: list the callers or the paths that deliver it, open each one, and report the claim when one behaves differently, including with optional features off. (ai-dynamo/dynamo#18443, #19038, #18804)
  4. Follow a move. When the diff moves, deletes, or merges a file, a constant, or a helper: search the whole repository, not only the touched crate, for other copies and for the old path in code owners, AGENTS.md, and docs, and say which remain; list the open pull requests that touch the old path (gh pr list --search <path>) and say where their changes must land. (ai-dynamo/dynamo#19038, #19039, #19251)

<!-- @bare -->
{{header}}

{{skills}}

## Scope

{{scope}}

Review this pull request and report every finding the code supports, each with a label.

## Output

{{output}}
