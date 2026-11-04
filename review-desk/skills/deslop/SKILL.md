---
name: deslop
description: Remove what a pull request does not need from its own diff - duplicate or redundant new types and structures, wrappers and abstractions with one caller, dead code, narrating comments, and defensive noise - without changing behavior. Use when asked to deslop, simplify, or clean up a branch before review.
---

# Deslop

Make the PR's diff smaller and plainer while keeping its behavior. The target is
what this branch added or changed (`git diff <merge-base>..HEAD`), not the rest
of the repository.

## Start

Read the repository's guidance (CLAUDE.md, AGENTS.md, CONTRIBUTING, nearest
scoped files) and the diff. Write down, for yourself, what the PR must still do
when you are done. That list is the boundary: nothing on it may change.

## What to remove or merge, biggest first

1. **New types that duplicate existing ones.** A struct, class, enum, or
   dataclass the PR added that has the same fields or variants as one that
   already exists, or as another new one. Merge into the existing type, or into
   one new type, and update every use.
2. **New structures with no second use.** Managers, registries, builders,
   factories, traits or interfaces with one implementation, config objects for
   one call site, and wrapper types that only rename or forward. Inline them
   into their one caller.
3. **Parallel state.** The same fact stored twice (a field and a derived copy, a
   map and a list of the same keys) where one can be computed from the other.
4. **Options and paths nobody uses.** Flags, parameters, fallbacks,
   compatibility shims, and extension points justified only by a possible future
   need; code paths no caller reaches; leftovers from an approach the PR
   abandoned.
5. **Helpers that hide one line.** Functions called once that wrap a short
   expression or a single call.
6. **Defensive noise.** try/except, catch-and-log, retries, `unwrap_or_default`,
   null checks, and validation on values that a trusted caller already
   guarantees. Keep checks at real boundaries: user input, network and file
   input, external APIs, and anything that guards data, money, or permissions.
7. **Comments a person would not write.** Narration of what the next line does,
   section banners, restated names, "added for X", change logs, and TODOs whose
   work is done. Keep comments that explain why, a non-obvious rule, an
   invariant, or a workaround with its reason.
8. **Type and style noise.** Casts or `as any` that only silence the checker,
   redundant annotations, `else` after `return`, debug prints, imports inside
   functions in Python, and names that do not match the file's conventions.

## Keep

- Behavior, public APIs, wire and storage formats, and saved contracts.
- Concurrency, ordering, transaction, permission, and idempotency boundaries.
- Tests for required behavior. Delete a test only with the code it tested.
- Logs, metrics, and traces that someone uses to operate the system.
- Structure that enforces a rule, even when it looks heavy. Show which layer is
  unused or duplicated before removing it; when the evidence is weak, leave it.
- Code the PR did not touch, unless a merge you make requires it.

## Method

- Search for every use before you merge, inline, or delete anything.
- Prefer deleting a concept to renaming it. Prefer three plain lines to a new
  abstraction. Prefer explicit code to dense one-liners.
- One logical cleanup per commit, so each can be reverted alone.
- After each cleanup run the narrowest check that proves behavior held:
  the touched crate's or package's tests, the type checker, the linter. Run the
  formatter last.
- Re-read the diff against the merge base at the end. It should be smaller, and
  every line that remains should have a reason.

## Report

What became simpler (types merged, structures inlined, lines removed), the
checks you ran and their results, and anything you left alone because removing
it was not clearly safe.

---

Drawn from the deslop skills of [Cursor](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/deslop/SKILL.md),
[Sentry](https://github.com/getsentry/outpost/blob/main/.agents/skills/deslop/SKILL.md) (Apache-2.0, after
[BYK/dotskills](https://github.com/BYK/dotskills)), [dcramer/peated](https://github.com/dcramer/peated/blob/main/skills/deslop/SKILL.md),
[rohitg00/pro-workflow](https://github.com/rohitg00/pro-workflow/blob/main/skills/deslop/SKILL.md), and Anthropic's
[code-simplifier](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md).
Tune this file: Review Desk's deslop stage uses it as written.
