// The PR factory, shared by server.ts and app.tsx: AI review rounds that post
// to GitHub, the hand-off to a human, and the CI babysitter. Prompts, reply
// parsing, and the GitHub review body live here; the wiring is in server.ts.
import { z } from "zod";

export const AI_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type AiSeverity = (typeof AI_SEVERITIES)[number];
export const AI_FINDING_STATUSES = ["open", "fixed", "obsolete"] as const;
export type AiFindingStatus = (typeof AI_FINDING_STATUSES)[number];

export const AI_REVIEW_FENCE = "ai-review";
export const BABYSIT_FENCE = "babysit";
/** Marks a review the factory posted, so a human review can be told apart from it under the same login. */
export const AI_ROUND_MARKER = "<!-- review-desk:ai-round";

/** Anything above a nit keeps a PR in AI review. */
export function isHighValue(severity: string): boolean {
  return severity !== "nit";
}

export interface PriorFinding { id: string; round: number; severity: string; path: string; line: number; title: string; body: string }

export interface RoundContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
  round: number;
  maxRounds: number;
  /** The round before this one: what it reviewed. Null for round 1. */
  prev: { baseSha: string; headSha: string } | null;
  prior: PriorFinding[];
  /** Unresolved GitHub threads, one line each. */
  threads: string[];
  changedPaths: string[];
  /** Skills you asked for on top of what the reviewer picks itself. */
  extraSkills: string[];
  /** May run empirical skills (builds, servers, GPU or load tests). */
  empirical: boolean;
}

export function reviewerIntro(c: { owner: string; repo: string; number: number; title: string }): string {
  return [
    `You are the AI reviewer for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}". Each message is one review round. Answer each round with exactly one fenced block tagged ${AI_REVIEW_FENCE} containing JSON, and nothing after it.`,
    "Your working directory is a detached worktree of the repository. Read code at the exact shas each round gives you (git show <sha>:<path>, git diff <a> <b>); the checkout may lag the head.",
    "You are read-only: never modify files, never commit, never push, never post to GitHub or comment on the PR. The server posts your result as a review.",
  ].join("\n");
}

const OUTPUT_SHAPE = [
  `Reply with one fenced block tagged ${AI_REVIEW_FENCE}:`,
  "{",
  '  "summary": string,            // 2-4 sentences for the PR author: what the change does and the overall verdict',
  '  "findings": [{ "path": string, "line": number, "endLine"?: number, "severity": "blocker"|"major"|"minor"|"nit", "title": string, "body": string, "suggestion"?: string }],',
  '  "previous": [{ "id": string, "status": "fixed"|"open"|"obsolete", "note": string }]   // one entry per earlier finding listed in this round; empty in round 1',
  "}",
  "severity: map whatever scale your skills use onto these four. nit means it would not hold up a merge on its own; a round that leaves only nits hands the PR to a human.",
  "path and line: a changed file and a line number at the head sha, on a line the diff adds or shows as context. endLine for a range.",
  "title: at most 12 words. body: GitHub Markdown written to the PR author: what is wrong, when it triggers, what it costs, and the fix. suggestion: replacement code for exactly those lines, only when the fix is obvious.",
].join("\n");

function howToReview(c: RoundContext): string[] {
  return [
    "How to review:",
    "- Use the code review skills available to you, both your own and any the repository provides (project skills, CLAUDE.md, AGENTS.md, CONTRIBUTING, review checklists in the tree). Pick the ones that fit this diff and the languages it touches, and follow their finding bar and validation steps.",
    ...(c.extraSkills.length > 0 ? [`- Also use: ${c.extraSkills.join(", ")}.`] : []),
    c.empirical
      ? "- A skill that reviews empirically (builds, launches servers, runs GPU or load tests) may be run when the change warrants it."
      : "- Skills that build the project, launch servers, or run GPU or load tests: apply their criteria by reading the code; do not run heavy workloads in an AI round. When a finding can only be settled by running it, say so in its body.",
    "- Report only what survives those skills' validation. With no review skill at hand, report only findings with a concrete trigger and a material consequence.",
  ];
}

export function roundPrompt(c: RoundContext): string {
  const head = [
    `Round ${c.round} of at most ${c.maxRounds} AI review rounds for ${c.owner}/${c.repo}#${c.number} "${c.title}"${c.author ? ` by ${c.author}` : ""}.`,
    `Merge base with ${c.baseRef}: ${c.baseSha}. Head: ${c.headSha}. Full diff: git diff ${c.baseSha} ${c.headSha}.`,
    `Changed files (${c.changedPaths.length}): ${c.changedPaths.slice(0, 120).join(", ")}${c.changedPaths.length > 120 ? ", ..." : ""}`,
    `PR description and conversation: gh pr view ${c.number} --repo ${c.owner}/${c.repo} --comments`,
    "",
  ];
  const threads = c.threads.length === 0 ? [] : ["", "Unresolved GitHub review threads (do not repeat what they already say):", ...c.threads.map((t) => `  ${t}`)];
  if (c.prev === null) {
    return [...head, ...howToReview(c), ...threads, "", OUTPUT_SHAPE].join("\n");
  }
  const rewritten = `If ${c.prev.headSha} is not an ancestor of ${c.headSha} the branch was rewritten; compare with git range-diff ${c.prev.baseSha}..${c.prev.headSha} ${c.baseSha}..${c.headSha}.`;
  return [
    ...head,
    `The previous round reviewed head ${c.prev.headSha}. This round is targeted: new commits are git log --oneline ${c.prev.headSha}..${c.headSha} and their diff is git diff ${c.prev.headSha} ${c.headSha}. ${rewritten}`,
    "",
    "Open findings from earlier rounds:",
    ...(c.prior.length === 0 ? ["  (none)"] : c.prior.map((f) => `  [${f.id}] round ${f.round}, ${f.severity}, ${f.path}:${f.line}: ${f.title}\n      ${f.body.replace(/\s+/g, " ").slice(0, 400)}`)),
    "",
    "Tasks:",
    "1. For every open finding above, decide fixed, open, or obsolete (the code is gone, or the author's reply in a thread shows it is not a problem; say why in note). Check the code at the new head, not the author's claim.",
    "2. Review what changed since the previous round, with the whole PR as context: bugs the fixes introduce, regressions, and new code. Do not raise again what is listed above, and do not raise new findings on code the new commits did not touch unless they make it wrong.",
    "",
    ...howToReview(c),
    ...threads,
    "",
    OUTPUT_SHAPE,
  ].join("\n");
}

const aiReplySchema = z.object({
  summary: z.string().default(""),
  findings: z
    .array(
      z.object({
        path: z.string(),
        line: z.coerce.number(),
        endLine: z.coerce.number().nullable().optional(),
        severity: z.string(),
        title: z.string(),
        body: z.string().default(""),
        suggestion: z.string().nullable().optional(),
      }),
    )
    .default([]),
  previous: z.array(z.object({ id: z.string(), status: z.string(), note: z.string().default("") })).default([]),
});
export type AiReply = z.infer<typeof aiReplySchema>;

/**
 * The JSON in a reply. Findings carry code in their bodies and suggestions,
 * so the tagged block is read greedily to the last fence, then as a plain json
 * block, then as whatever sits between the outer braces.
 */
function replyJson(text: string, fence: string): unknown {
  const candidates: string[] = [];
  const tagged = new RegExp("```" + fence + "[^\\n]*\\n([\\s\\S]*)```", "i").exec(text);
  if (tagged !== null) candidates.push(tagged[1]);
  const json = /```json[^\n]*\n([\s\S]*)```/i.exec(text);
  if (json !== null) candidates.push(json[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  throw new Error(`no readable ${fence} block in the reply`);
}

export function parseAiReply(text: string): AiReply {
  const reply = aiReplySchema.parse(replyJson(text, AI_REVIEW_FENCE));
  return {
    ...reply,
    findings: reply.findings
      .filter((f) => f.line > 0 && f.title.trim() !== "")
      .map((f) => ({ ...f, severity: (AI_SEVERITIES as readonly string[]).includes(f.severity) ? f.severity : "minor" })),
  };
}

export interface PostedFinding { severity: string; path: string; line: number; startLine: number | null; title: string; body: string; suggestion: string | null }

export function findingComment(f: PostedFinding, round: number): string {
  const parts = [`**[${f.severity}] ${f.title.trim()}** (AI review, round ${round})`, f.body.trim()];
  if (f.suggestion !== null && f.suggestion.trim() !== "") parts.push("```suggestion\n" + f.suggestion.replace(/^```\w*\n?|```$/g, "").replace(/\n$/, "") + "\n```");
  return parts.filter((p) => p !== "").join("\n\n");
}

/** The review body: header, summary, what happened to earlier findings, and what could not go inline. */
export function reviewBody(args: {
  round: number;
  maxRounds: number;
  summary: string;
  counts: Record<AiSeverity, number>;
  resolved: { title: string; status: AiFindingStatus; note: string }[];
  stillOpen: { title: string; severity: string }[];
  nits: PostedFinding[];
  offDiff: PostedFinding[];
  handoff: boolean;
}): string {
  const lines = [
    `### Round ${args.round} AI review`,
    `_Automated review (round ${args.round} of up to ${args.maxRounds} before a human review). Findings may be wrong; reply on a thread to dispute one._`,
    "",
  ];
  if (args.summary.trim() !== "") lines.push(args.summary.trim(), "");
  const tally = AI_SEVERITIES.filter((s) => args.counts[s] > 0).map((s) => `${args.counts[s]} ${s}`);
  lines.push(`**New findings:** ${tally.length === 0 ? "none" : tally.join(", ")}`);
  if (args.resolved.length > 0 || args.stillOpen.length > 0) {
    const fixed = args.resolved.filter((r) => r.status === "fixed").length;
    const obsolete = args.resolved.filter((r) => r.status === "obsolete").length;
    lines.push(`**Earlier findings:** ${fixed} fixed, ${obsolete} no longer apply, ${args.stillOpen.length} still open`);
    for (const r of args.stillOpen) lines.push(`- still open (${r.severity}): ${r.title}`);
    for (const r of args.resolved.filter((x) => x.status === "obsolete" && x.note.trim() !== "")) lines.push(`- no longer applies: ${r.title} (${r.note.trim()})`);
  }
  const listed = (items: PostedFinding[]) => items.map((f) => `- \`${f.path}:${f.line}\` **[${f.severity}] ${f.title.trim()}**: ${f.body.trim().replace(/\n+/g, " ")}`);
  if (args.offDiff.length > 0) lines.push("", "**Findings outside the diff:**", ...listed(args.offDiff));
  if (args.nits.length > 0) lines.push("", `<details><summary>Nits (${args.nits.length})</summary>`, "", ...listed(args.nits), "", "</details>");
  lines.push("", args.handoff ? "_AI review is done; a human reviewer takes it from here._" : "_The next AI round runs after new commits are pushed._");
  lines.push(`${AI_ROUND_MARKER} ${args.round} -->`);
  return lines.join("\n");
}

// -- babysitter -------------------------------------------------------------

export const BABYSIT_OUTCOMES = ["rerun", "waiting", "needs_human", "ok"] as const;
export type BabysitOutcome = (typeof BABYSIT_OUTCOMES)[number];

export function babysitIntro(c: { owner: string; repo: string; number: number; title: string }): string {
  return [
    `You babysit CI for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}" until it merges. Each message is one pass. Answer each pass with exactly one fenced block tagged ${BABYSIT_FENCE} containing JSON, and nothing after it.`,
    "Hard rules: never edit files, never commit, never push, never merge, never close, never comment on the PR or its threads. The only GitHub write you may make is re-running failed jobs (gh run rerun <run-id> --failed).",
    "Anything that needs a code change, a rebase, a push, or a decision goes back to the human: report needs_human and stop.",
  ].join("\n");
}

export function babysitPrompt(c: { owner: string; repo: string; number: number; headSha: string; pass: number; maxPasses: number; failing: { name: string; url: string | null }[]; conflicting: boolean }): string {
  return [
    `Pass ${c.pass} of at most ${c.maxPasses} at head ${c.headSha} of ${c.owner}/${c.repo}#${c.number}.`,
    c.conflicting ? "GitHub reports merge conflicts with the base branch." : "",
    c.failing.length === 0 ? "No failing checks are reported." : `Failing checks:\n${c.failing.map((f) => `  ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n")}`,
    "",
    "If you have a skill for watching a PR's CI, use it to diagnose; the rules you were given win over it. Otherwise read gh pr checks and gh run view --log-failed.",
    "Decide for each failure whether the PR caused it. Re-run the failed jobs the PR did not cause (infra, flakes, cancelled runs), once per pass. Do nothing else on GitHub.",
    "",
    `Reply with one fenced block tagged ${BABYSIT_FENCE}:`,
    '{ "outcome": "rerun" | "waiting" | "needs_human" | "ok", "detail": string }',
    "rerun: you re-ran flaky or infra jobs. waiting: checks are still running and nothing needs doing. ok: nothing is failing. needs_human: a failure is caused by the PR, there are merge conflicts, a re-run cannot help, or you are unsure.",
    "detail: one or two sentences for the human: which check, why, and what they need to do (for example: ask the author to rebase, or fix the failing test in path/to/test.py).",
  ].filter((l) => l !== "").join("\n");
}

const babysitReplySchema = z.object({ outcome: z.enum(BABYSIT_OUTCOMES), detail: z.string().default("") });

export function parseBabysitReply(text: string): { outcome: BabysitOutcome; detail: string } {
  return babysitReplySchema.parse(replyJson(text, BABYSIT_FENCE));
}
