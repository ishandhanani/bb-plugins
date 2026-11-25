---
name: factory-learn
description: Weekly evaluation of the PR factory - read what happened on merged PRs (recall against human reviewers, addressed rate of AI findings), keep the replay set of frozen PR heads honest, measure the review prompt against a bare baseline, propose and retire prompt rules, and report. Use for the weekly factory-learn automation or when asked how well the factory reviews.
---

# Factory learn

The PR factory (Review Desk) reviews a pull request before a person does. This procedure measures how well it does that, and uses the measurement to change it: add a rule that earns its place, and delete one that does not. Models get better with every release, so a part of the prompt that helped last quarter may be dead weight now. The evals decide; nothing is kept on belief.

It never lands an edit. It writes patches and a report; the author approves.

## The two measures

- **Recall on a reviewed head.** Of the comments a human reviewer made on a commit the AI had already reviewed, how many had the AI raised first. Comments made before the AI looked, or on a commit it never saw, measure the factory's timing, not its review, and are reported apart.
- **Addressed rate.** Of the findings the AI posted, how many led to a change. This is the precision signal: a finding nobody acts on is noise.

Low recall against humans is normal for every tool that publishes it (15 to 40 percent). The change between two variants on the same heads matters more than the level.

## Inputs

- Telemetry: `~/.review-desk/telemetry/events.jsonl`, one JSON object per line. Read it with a script; never print the whole file.
  - `type: "recall"`, one per merged PR: `total`, `found`, `demoted`, `missed` over every human comment; `reviewedFirst` with the same four counts over comments whose `timing` is `reviewed`; `addressed` (`posted`, `addressed`, `declined`, `ignored`, `unjudged`, and `byLabel`, `bySource` (review or perf), `byModel`); `items`, each human comment with `url`, `author`, `category`, `match`, `finding`, `cause`, `home`, `rule`, `timing`.
  - `type: "pr_closed"`: the raw material: `prBody`, `humans` (with `path`, `line`, `body`, `createdAt`, `commit`, `timing`), `findings` (with `source`, `model`, `status`), `rounds` (head and model of each), `fixRuns`.
  - `type: "job"`: every factory job: `stage`, `prompt.version`, `skills`, `model`, `result` (a review round's `result.prBody` is the PR description as that round saw it).
- State: `~/.review-desk/learn/state.json` holds `lastRunAt`. Read records with `at` later than it; on a first run take the last 14 days.
- Replay set: `~/.review-desk/learn/replay-set.json`. Noise floor and baselines: `~/.review-desk/learn/baselines.json`.
- Rules: `~/bb-plugins/review-desk/prompts/rules.json`, every rule this procedure added to a prompt, with its status.
- What can change: the stage prompts (`~/bb-plugins/review-desk/prompts/*.md`), the skills map (`factory-skills.json`), the author's own skills (`~/.claude/skills/`), and, by a pull request the author opens, a repository's `AGENTS.md` files and skills.

## Steps

1. **The week's numbers.** From the new `recall` records, per PR and in total: recall on a reviewed head (`reviewedFirst`), the comments that were not on a reviewed head (count only, with the cause), and the addressed rate, by label, by source, and by model. Say the sample size beside every rate. With no new records, write that and go to step 4.
2. **Check the misses.** For every `reviewedFirst` item that is not `found`, read the comment in `pr_closed` and confirm the cause the matcher gave (for `factory_introduced`, find the commit in `fixRuns`). Correct a wrong one and say so. Cluster the `rule` sentences of the `rule_missing`, `needs_context`, and `mechanical` ones; a cluster needs two comments, or one that repeats a rule from an earlier report.
3. **Grow the replay set** (see The replay set).
4. **Spend the replay budget** (see Budget) in this order: the noise floor if it is not known for the current prompt and model; the bare baseline; rules due for review; new proposals; one ablation.
5. **Decide on rules** (see Rules).
6. **Report**, update `state.json`, and end your turn with the report's summary and its path.

## The replay set

One entry is a frozen head of a merged PR with what is known to be wrong there.

- `pr`, `head`, `base` (the merge base with the default branch), `repoPath`, `description` (the PR description as a round saw it at that head, from the nearest `job` record; null when none was recorded).
- `humans`: the human comments made on that commit.
- `confirmed`: the AI findings raised in production at or before that head that were later `addressed`. People do not notice everything; a finding the author acted on is also ground truth.
- `clean: true` when a person reviewed that head after an AI round and asked for nothing; the right answer there is no finding above a NIT.
- `split`: `held` for every third entry by order of addition, `tune` for the rest. Proposals are written from `tune` heads only and judged on `held` heads.

Adding: for each newly merged PR, one entry per head that has a `reviewed` or `unreviewed_head` human comment, plus one clean entry when there is one. Keep at most 50; drop the oldest `tune` entries first, and never the four oldest (they are the anchors that make weeks comparable).

## Replay

A replay runs the factory's round-1 review on a frozen head and scores it. It posts nothing.

1. Worktree: in the entry's `repoPath`, `git fetch <remote> refs/pull/<number>/head`, then `git worktree add --detach /tmp/factory-replay/<number>-<short sha> <head>`. Remove it afterwards. Never check out a branch in the main checkout.
2. Prompt: `bb review-desk factory prompt <reviewId> --head <head> --base <base> --skills-sha <base> --description <file> --replay --json`. `--skills-sha <base>` reads the repository's skills as they were at the merge base, so a replay never sees rules the PR itself added. `--replay` tells the reviewer to stay off GitHub, where the answers are. Variants: `--variant bare` (only the task, the repository's skills, and the output format) and `--omit procedures|personal|repo|agents|topic`. When the PR is no longer on the board, build the same text from `prompts/review.md` by hand and say so.
3. For a proposal: copy the prompt or skill file, apply the patch to the copy, and use that copy for the variant. Change nothing else.
4. Run each variant as a fresh read-only subagent with the prompt as its whole task, in the worktree, on the model the factory's reviewer uses (`model` of recent `ai_review` job records); record the model you actually used.
5. Score each run with two numbers and a count:
   - grounded recall: human comments at that head that a finding names at the same place, over all of them;
   - confirmed recall: the same over `confirmed`;
   - extras: findings above a NIT that match neither. On a `clean` head every finding above a NIT is an extra.
   Do not call an extra wrong. When two variants differ by more than three extras on a head, judge up to five of them against the code (real and worth raising, or not) and report the share.
6. **Three runs per variant per head.** Report the mean and the lowest and highest. One run decides nothing.

## Budget

At most 45 replay runs in one weekly run. A review takes 5 to 10 minutes; run them a few at a time.

1. **Noise floor** (once per prompt version and model, 12 runs): the full prompt, three runs, on four heads. The spread between identical runs is the noise floor; store it in `baselines.json` with the prompt version, the model, and the heads. No difference smaller than it counts.
2. **Bare baseline** (12 runs): `--variant bare` on the same four heads. This is what the model does with almost no help. Every part of the prompt has to beat it.
3. **Rules due** and **new proposals** (up to 18 runs): each on two `held` heads its cluster points at plus one control, three runs each. Reuse the stored full-prompt runs as the comparison.
4. **One ablation** with what is left: remove one part (`--omit procedures`, then `personal`, then `agents`, one per week, in turn) on the four noise-floor heads.

When a new model is in use (the `model` of recent `ai_review` jobs changed), spend the whole budget on steps 1, 2, and 4 for it, and compare with the stored numbers of the old model. A new model is not assumed better, and a part that the old model needed is not assumed needed.

## Rules

Every rule this procedure adds is an entry in `prompts/rules.json`: `id`, `file`, `anchor` (the first words of its text), `added`, `status`, `reviewBy`, `source`, `evidence`.

- **candidate**: applied, not yet proven. A new proposal lands as a candidate with `reviewBy` four weeks out.
- **kept**: on its review date it beat the comparison by more than the noise floor on `held` heads, or reviewer comments of its kind stopped arriving on reviewed heads while they kept arriving before it. Say which.
- **retire**: propose a patch that deletes it when, on its review date, it did not beat the noise floor, or when the bare baseline matches the full prompt on the heads it was written for. Deleting is the default for a rule with no evidence; a rule is not kept because it sounds right.
- A rule for one repository goes to that repository's `AGENTS.md` (a pull request the author opens), never into the author's own skills.
- A check a command can do (code owners on a moved path, broken doc links, a description that names a renamed test) is proposed as a script or a lint, not as prompt text.
- Each report proposes at least as many deletions as it considered; "nothing to delete" needs the numbers that say so.

A proposal is a patch file plus the `rules.json` entry it adds or changes.

## Report

Write `~/.review-desk/learn/<date>/report.md`, with patches in `proposals/` beside it:

- The week: PRs merged; recall on a reviewed head; comments not on a reviewed head, by cause; addressed rate by label, source, and model. Sample sizes with every rate.
- The misses on reviewed heads, by cause, each with one quoted comment and its URL.
- Process findings: heads nobody reviewed, findings that were lost, commits the factory wrote that a reviewer rejected, jobs that failed.
- The evals: the noise floor; bare against full; each ablation; each as mean with lowest and highest, on which heads, with which model. State plainly when a difference is inside the noise.
- Rules: each candidate due, with its numbers and the verdict; new proposals; deletions.
- What you could not check.

Read at least three of the failed replay or production transcripts behind the numbers before you write the report, and say what they showed. A score nobody has looked behind is not a finding.

## Limits

- Do not edit a prompt, `rules.json`, `factory-skills.json`, a skill, or an `AGENTS.md`. Proposals are patch files.
- Do not post to GitHub, push, open a pull request, or add a PR to the Review Desk board.
- A comment the author declined is still a miss when the reviewer never saw the code; record the decline and propose no rule from it.
