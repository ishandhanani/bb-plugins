{{pr}} has merged. Compare what human reviewers said on it with what the AI review found, so the review skills and prompts can be improved.

Human review comments (JSON). `commit` is the commit the comment was made on. `timing` was worked out from that and is not yours to change: `reviewed` means an AI round had already reviewed that commit when the person commented, `unreviewed_head` means AI rounds had run but not on that commit, `before_review` means no AI round had finished yet.

{{humans}}

AI review findings, with the round that raised each, its label, and what happened to it (JSON):

{{findings}}

What the author's agent did with each comment it judged (JSON):

{{fixItems}}

Review rounds: the head each one reviewed and when (JSON):

{{rounds}}

For each human comment that asks for a change or questions the code (skip approvals, thanks, and replies that add no new point), decide:

- found: an AI finding named the same problem at the same place before the human did, and it was fixed or still open when the human commented.
- demoted: an AI finding named it first, but it was labeled NIT, skipped by the author's agent, or left open, so the human had to raise it again.
- missed: no AI finding named it. Then give the cause, one of:
  - not_reviewed: the comment's `timing` is `unreviewed_head` or `before_review`. Use this cause for every such comment that no finding named first, and for no other.
  - factory_introduced: the author's agent wrote the commented code (a fix, deslop, or CI commit).
  - rule_missing: the reviewer saw the code and no rule told it to look for this.
  - needs_context: the problem is in code outside the diff, or needs knowledge of a sibling path, a default, or a measurement.
  - mechanical: a grep, lint, or script would have found it.
- home: where a fix for a miss belongs: repo_agents_md (a rule for this repository's AGENTS.md or skills), personal_skill (a rule for the author's own review skills, true in any repository), prompt (when or what the factory reviews), or none.
- rule: one imperative sentence a reviewer could apply to any diff, or "" when the comment is specific to this PR.

AI findings that no round had marked fixed or obsolete when the PR merged (JSON):

{{open}}

For each of those, look at the merged code ({{mergedSha}}) and decide what became of it:

- addressed: the code changed in the way the finding asked, or in another way that removes the problem.
- declined: the author answered it (on its thread or in a later commit message) and left the code as it was.
- ignored: the code is unchanged and nobody answered.

Use git and gh in this worktree when you need the code or a comment's diff hunk. Do not modify files or post anything.

Reply with one fenced block tagged ai-learn:
{
  "summary": string,
  "items": [{ "url": string, "author": string, "category": string, "match": "found"|"demoted"|"missed", "finding": string, "cause": string, "home": string, "rule": string }],
  "findings": [{ "id": string, "outcome": "addressed"|"declined"|"ignored", "note": string }]   // one per finding in the second list; empty when that list is empty
}
category is one of: perf-hot-path, concurrency, correctness, design, dead-surface, simplify, error-handling, tests, docs-naming, scope, compat, question. finding is the AI finding's id, or "".
