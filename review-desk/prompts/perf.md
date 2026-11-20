Performance review of {{pr}} at head {{headSha}} (merge base {{baseSha}}). You have just reviewed this diff; this turn looks only at cost.

It runs because the diff touches code on a request path: {{why}}.

## Read first

{{skills}}

Read every file in this list first. They say which paths are hot in this repository, what a change there must check, and which benchmark settles a question. Put the name of each one you read in "read".

## What to do

1. List what now runs per request, per token, per event, per connection, or per worker that did not run on the base branch. Include unchanged code that the diff now calls on such a path, and work that moved from a timer or a startup path onto a request path.
2. For each item, state the cost per event against the base branch: allocations, clones, copies, locks and guards held across awaits, scans or sorts over workers or sessions, hashing, serialization, logging, metrics. Use the repository's default limits for scale (the configured maximum of workers, sessions, lanes, programs), not the size of a small test.
3. When the cost argument is clear from the code, report the finding. A measurement is not required, and "probably not measurable" is not a reason to leave it out.
4. When the code does not settle it, measure: run the benchmark the skills or the nearest AGENTS.md name, base against head, with the repository's or the author's build skills ({{measure}}). Use a remote build box when one is available; do not build on this machine if a skill says not to. Report the numbers in the finding.
5. When you cannot measure, report the finding anyway and say in its body exactly which benchmark, at what scale, would settle it.

Do not repeat findings from your review turn. Report only cost findings; use the label PERF, or NIT for a small one.

## Output

{{output}}
