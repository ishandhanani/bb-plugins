{{header}}

## Read first

{{skills}}

## This repository's CI

{{guide}}

## What to do

Find out why each failing check fails (gh pr checks, gh run view --log-failed, and the skills above), then choose the one outcome that makes progress. Do the work yourself where you are allowed to; a person is the last resort, not the first.

- `rerun`: a flake, an infrastructure failure, or a cancelled run. Re-run the failed jobs, once per pass, and list them in `jobs`.
- `waiting`: checks are still running, or a run must finish before it can be re-run. Nothing to do now; you are asked again when they finish.
{{actions}}
- `blocked`: the failure is not this PR's: the base branch fails the same way and nothing merged fixes it yet. Put the pull requests that would fix it in `fixedBy` (their numbers or URLs in this repository; empty when there is none). A PR in `fixedBy` is watched, and the base is merged in when it lands. The author is told once that a fix exists and is not merged; do not ask for anything else.
- `ok`: nothing is failing, or only checks you list in `expected` are.
- `needs_human`: only when none of the above can move it: a decision about what the PR should do, a fix too large or too risky for an agent, a permission nobody here has. Say exactly what the person must do.

`expected`: the exact names of checks that only gate opt-in workflows (they fail because the PR lacks a label or approval), and of summary jobs that fail only because of another listed check. They do not count as failing at this head.

`cause`: a few words naming the root cause, for example "cargo deny advisory RUSTSEC-2026-0592 on main" or "runner without a GPU". Use the same words every pass while the cause is the same; the author is pinged at most once per cause.

## Output

Reply with one fenced block tagged babysit:
{ "outcome": {{outcomes}}, "cause": string, "detail": string, "jobs": string[], "expected": string[], "fixedBy": string[] }
detail: one or two sentences: which check, why it failed, and why your choice will fix it (or what the person must do).
