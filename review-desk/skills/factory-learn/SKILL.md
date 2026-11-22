---
name: factory-learn
description: Weekly review of the PR factory against human reviewers - read the recall records written after each merge, cluster what the AI review missed, propose skill and prompt changes, replay each proposal on frozen PR heads, and report. Use for the weekly factory-learn automation or when asked why the factory missed a reviewer's comments.
---

# Factory learn

The PR factory (Review Desk) reviews a pull request before a person does. After
each merge it writes what the people said next to what the AI found. This
procedure turns a week of those records into proposed changes, checks each one
by replay, and reports. It never lands an edit: the author approves first.

## Inputs

- Telemetry: `~/.review-desk/telemetry/events.jsonl`, one JSON object per line. Read it with a script; never print the whole file.
  - `type: "recall"`: one per merged PR. `pr`, `total`, `found`, `demoted`, `missed`, and `items`: each human comment with `url`, `author`, `category`, `match` (`found`, `demoted`, `missed`), `finding`, `cause`, `home`, `rule`.
  - `type: "pr_closed"`: the raw material for the same PR: `humans` (the comments, with `path`, `line`, `body`, `createdAt`), `findings`, `rounds` (the head each round reviewed), `fixRuns`.
  - `type: "job"`: every factory job, with `stage`, `prompt.version`, `skills` (the files it was told to read, with digests), `result`.
- State: `~/.review-desk/learn/state.json` holds `lastRunAt` (ISO time). Read records with `at` later than it. Create the file on the first run and take the last 14 days.
- Replay set: `~/.review-desk/learn/replay-set.json`, a list of frozen heads: `pr`, `head`, and `humans` (what reviewers said at that head).
- What can change:
  - the stage prompts, `~/bb-plugins/review-desk/prompts/*.md` (process: when and what to review);
  - the skills map, `~/bb-plugins/review-desk/factory-skills.json` (which skills each stage reads, and the request paths that trigger a perf review);
  - the author's own skills in `~/.claude/skills/` (rules that hold in any repository);
  - the repository's `AGENTS.md` files and skills (rules for that repository). These are owned by the repository; a change there is a pull request the author opens.

## Steps

1. Read the new `recall` records. For each PR give total, found, demoted, missed, and recall (found over total). Give the week's totals, by category and by cause. If there are none, write a two-line report and stop.
2. For every item that is not `found`, read the comment in the matching `pr_closed` record. Check the cause the matcher gave against the data: for `not_reviewed`, compare the comment's time and commit with the rounds' heads; for `factory_introduced`, find the commit in `fixRuns`. Correct a cause that is wrong and say so.
3. Group the misses by cause, then by `home`:
   - `not_reviewed` and `factory_introduced` are about the process. They point at the prompts, the settings, or the factory's code, not at a skill.
   - `demoted` means the reviewer saw it and it was lost. Look at the label it got and at what the author's agent did with it; the fix is in `prompts/review.md` (labels) or `prompts/fix.md` (triage).
   - `rule_missing`, `needs_context`, and `mechanical` point at a rule or a procedure. Cluster the `rule` sentences; a cluster needs at least two comments, or one comment that repeats a rule already seen in an earlier week's report.
4. For each cluster, check that the rule is not already written where the reviewer reads it: the files named in `factory-skills.json` for that repository, the `AGENTS.md` of the touched directories at the repository's default branch, and `~/.claude/skills/`. A rule that is written and was not followed is a different problem from a rule that is missing; say which.
5. Write each proposal as a patch file: the smallest edit that would have caught the cluster. One rule is one or two lines, in the words a reviewer would act on, with the PR it came from. Do not copy a reviewer's rule for a repository into the author's own skills; propose it for that repository's `AGENTS.md` instead.
6. Replay each proposal that changes a skill, an `AGENTS.md`, or `prompts/review.md` (see Replay). Keep a proposal only when it finds more of the expected comments than the baseline without a jump in findings that match nothing.
7. Add this week's merged PRs to the replay set: for each PR with a human comment that was not `found`, one entry at the head the comment was made on, with the comments on that head. Keep the set under 30 entries; drop the oldest.
8. Write the report (see Report), update `state.json`, and end your turn with the report's summary and its path.

## Replay

A replay runs the factory's round-1 review on a frozen head and scores it against what reviewers said there. It posts nothing.

1. Get a worktree at the head. Use the checkout Review Desk uses for that repository (`bb review-desk list --json` gives each review's `repoPath`): `git fetch <remote> refs/pull/<number>/head`, then `git worktree add --detach /tmp/factory-replay/<number>-<short sha> <head>`. Remove it when you are done (`git worktree remove`). Do not check out branches in the main checkout.
2. Render the prompt. When the PR is still on the Review Desk board, `bb review-desk factory prompt <reviewId> --head <head> --base <merge base> --json` prints the exact prompt and the skill files. Otherwise build it from `prompts/review.md`: the text before the first `<!-- @... -->` marker, with `{{scope}}` from the `scope-first` section, `{{empirical}}` from `empirical-off`, and the skills list from `factory-skills.json`.
3. For the variant with the proposal: copy the skill or `AGENTS.md` file to a scratch folder, apply the patch there, and point that one line of the "Read first" list at the copy. Change nothing else.
4. Run each variant as a fresh subagent with the prompt as its whole task, in the worktree, read-only. Use the model the factory's reviewer uses (the `model` field of recent `ai_review` job records). One run per variant per head; a review takes 5 to 10 minutes, so replay at most three heads per proposal: the heads its cluster came from, plus one head it should not affect.
5. Score: for each expected human comment at that head, did a finding name the same problem at the same place? Count findings that match no comment too.
6. Keep each baseline result in `~/.review-desk/learn/baselines.json`, keyed by head and by the digests of the skill files, so the same baseline is not run twice.

## Report

Write `~/.review-desk/learn/<date>/report.md`, with the patches beside it in `proposals/`:

- The week: PRs merged, human comments, found, demoted, missed, recall; the same per PR.
- The misses by cause, with one example comment each (quote it, with its URL).
- Process findings: heads nobody reviewed, findings that were lost, commits the factory wrote that a reviewer rejected.
- Each proposal: the file, the patch, the comments it would have caught, the replay result (baseline against variant, per head), and where it goes (the plugin, the author's skills, or a pull request to the repository).
- What you could not check.

Write plainly. Give numbers with their sample size; a week is usually a handful of PRs, so do not read a trend into it.

## Rules

- Do not edit a skill, a prompt, `factory-skills.json`, or an `AGENTS.md`. Proposals are patch files.
- Do not post to GitHub, push, or open a pull request.
- Do not add a PR to the Review Desk board.
- A comment the author declined is still a miss by the reviewer when the reviewer never saw it; record the decline, and do not propose a rule from it.
