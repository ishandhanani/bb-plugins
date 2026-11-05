// The PR factory, shared by server.ts and app.tsx: AI review rounds that post
// to GitHub, the hand-off to a human, and the CI babysitter. Prompts, reply
// parsing, and the GitHub review body live here; the wiring is in server.ts.
import { z } from "zod";

/** What a finding is, in the order a reviewer should read them. Only NIT never holds up a merge. */
export const AI_LABELS = ["BLOCKER", "BUG", "PERF", "TEST", "DESIGN", "QUESTION", "NIT"] as const;
export type AiLabel = (typeof AI_LABELS)[number];

export const AI_LABEL_MEANING: Record<AiLabel, string> = {
  BLOCKER: "must be fixed before merge: wrong results, a crash, data loss, a security hole, or a broken contract on a common path",
  BUG: "a real bug on a less common path",
  PERF: "a measurable cost on a hot path: allocations, copies, locking, serialization, or repeated work per request",
  TEST: "risky logic with no test, or a test that does not check what it claims",
  DESIGN: "structure, API, or naming that will cause bugs or make the code hard to change",
  QUESTION: "something only the author can answer; the review cannot tell whether it is right",
  NIT: "style, naming, comments, small cleanups; never holds up a merge on its own",
};

/** Findings stored before labels (blocker, major, minor, nit) keep working. */
const LEGACY_LABELS: Record<string, AiLabel> = { blocker: "BLOCKER", major: "BUG", minor: "DESIGN", nit: "NIT" };

export function normalizeLabel(value: string): AiLabel {
  const upper = value.trim().toUpperCase();
  return (AI_LABELS as readonly string[]).includes(upper) ? (upper as AiLabel) : LEGACY_LABELS[value.trim().toLowerCase()] ?? "BUG";
}
export const AI_FINDING_STATUSES = ["open", "fixed", "obsolete"] as const;
export type AiFindingStatus = (typeof AI_FINDING_STATUSES)[number];

export const AI_REVIEW_FENCE = "ai-review";
export const BABYSIT_FENCE = "babysit";
/** Starts every comment and review the factory posts under your login, so it is never read as your own feedback. */
export const FACTORY_MARKER = "<!-- review-desk:";
/** Marks a review an AI round posted. */
export const AI_ROUND_MARKER = `${FACTORY_MARKER}ai-round`;

/** Anything but a NIT keeps a PR in AI review. */
export function isHighValue(label: string): boolean {
  return normalizeLabel(label) !== "NIT";
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

/** Where a thread's commands run: it starts in a folder shared by every PR of the repository, so it works in its own worktree. */
function worktreeLine(worktree: string): string {
  return `The PR's worktree is ${worktree}. Your shell starts in a folder shared by every PR under review in this repository, so run each command in the worktree: cd ${worktree} && <command>, or git -C ${worktree} <args>.`;
}

export function reviewerIntro(c: { owner: string; repo: string; number: number; title: string; worktree: string }): string {
  return [
    `You are the AI reviewer for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}". Each message is one review round. Answer each round with exactly one fenced block tagged ${AI_REVIEW_FENCE} containing JSON, and nothing after it.`,
    worktreeLine(c.worktree),
    "Read code at the exact shas each round gives you (git show <sha>:<path>, git diff <a> <b>); the checkout may lag the head.",
    "You are read-only: never modify files, never commit, never push, never post to GitHub or comment on the PR. The server posts your result as a review.",
  ].join("\n");
}

const OUTPUT_SHAPE = [
  `Reply with one fenced block tagged ${AI_REVIEW_FENCE}:`,
  "{",
  '  "summary": string,            // 2-4 sentences for the PR author: what the change does and the overall verdict',
  `  "findings": [{ "path": string, "line": number, "endLine"?: number, "label": ${AI_LABELS.map((l) => `"${l}"`).join("|")}, "title": string, "body": string, "suggestion"?: string }],`,
  '  "previous": [{ "id": string, "status": "fixed"|"open"|"obsolete", "note": string }]   // one entry per earlier finding listed in this round; empty in round 1',
  "}",
  "label: the one bucket that fits best. Map whatever scale your skills use onto these:",
  ...AI_LABELS.map((l) => `  ${l}: ${AI_LABEL_MEANING[l]}`),
  "A round that leaves only NITs hands the PR to a human.",
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
  const p = c.prev;
  return [
    ...head,
    `The previous round reviewed head ${p.headSha} (merge base ${p.baseSha}). This round is targeted at what the PR itself changed since then. That is the difference between the PR's diff then (git diff ${p.baseSha} ${p.headSha}) and now (git diff ${c.baseSha} ${c.headSha}), not git diff ${p.headSha} ${c.headSha}, which also carries everything merged in from ${c.baseRef}. Compare the two per file, for example diff <(git diff ${p.baseSha} ${p.headSha} -- <path>) <(git diff ${c.baseSha} ${c.headSha} -- <path>). The PR's own new commits, with merges from ${c.baseRef} shown as one line each: git log --first-parent --oneline ${p.headSha}..${c.headSha} (after a rebase, git range-diff ${p.baseSha}..${p.headSha} ${c.baseSha}..${c.headSha}).`,
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
        label: z.string().optional(),
        severity: z.string().optional(),
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

/** A reply with every finding's label normalized into `severity` (the stored field) and sorted BLOCKER first. */
export type ParsedAiReply = Omit<AiReply, "findings"> & { findings: (AiReply["findings"][number] & { severity: string })[] };

export function parseAiReply(text: string): ParsedAiReply {
  const reply = aiReplySchema.parse(replyJson(text, AI_REVIEW_FENCE));
  return {
    ...reply,
    findings: reply.findings
      .filter((f) => f.line > 0 && f.title.trim() !== "")
      .map((f) => ({ ...f, severity: normalizeLabel(f.label ?? f.severity ?? "") as string }))
      .sort((a, b) => AI_LABELS.indexOf(a.severity as AiLabel) - AI_LABELS.indexOf(b.severity as AiLabel)),
  };
}

export interface PostedFinding { severity: string; path: string; line: number; startLine: number | null; title: string; body: string; suggestion: string | null }

/** The first line of a finding's inline comment; also how the factory finds its own thread later. */
export function findingHeader(severity: string, title: string, round: number): string {
  return `**[${severity}] ${title.trim()}** (AI review, round ${round})`;
}

export function findingComment(f: PostedFinding, round: number): string {
  const parts = [findingHeader(f.severity, f.title, round), f.body.trim()];
  if (f.suggestion !== null && f.suggestion.trim() !== "") parts.push("```suggestion\n" + f.suggestion.replace(/^```\w*\n?|```$/g, "").replace(/\n$/, "") + "\n```");
  return parts.filter((p) => p !== "").join("\n\n");
}

/** The review body: header, summary, what happened to earlier findings, and what could not go inline. */
export function reviewBody(args: {
  round: number;
  maxRounds: number;
  summary: string;
  counts: Record<AiLabel, number>;
  resolved: { title: string; status: AiFindingStatus; note: string }[];
  stillOpen: { title: string; severity: string }[];
  nits: PostedFinding[];
  offDiff: PostedFinding[];
  handoff: boolean;
  /** What happens next, when it is neither a hand-off nor waiting for a push. */
  next?: string;
}): string {
  // Folded under one line, so the PR conversation stays short; the findings themselves are inline on their lines.
  const tally = AI_LABELS.filter((l) => args.counts[l] > 0).map((l) => `${args.counts[l]} ${l}`);
  const fixed = args.resolved.filter((r) => r.status === "fixed").length;
  const obsolete = args.resolved.filter((r) => r.status === "obsolete").length;
  const earlier = args.resolved.length > 0 || args.stillOpen.length > 0 ? `earlier: ${fixed} fixed, ${args.stillOpen.length} still open` : null;
  const headline = [`<b>Round ${args.round} AI review</b>`, tally.length === 0 ? "no new findings" : tally.join(", "), earlier].filter((x) => x !== null).join(" · ");
  const lines = [`<details><summary>${headline}</summary>`, "", `_Automated review, round ${args.round} of up to ${args.maxRounds} before a human review. Findings may be wrong; reply on a thread to dispute one._`, ""];
  if (args.summary.trim() !== "") lines.push(args.summary.trim(), "");
  if (earlier !== null) {
    lines.push(`**Earlier findings:** ${fixed} fixed, ${obsolete} no longer apply, ${args.stillOpen.length} still open`);
    for (const r of args.stillOpen) lines.push(`- still open **[${normalizeLabel(r.severity)}]** ${r.title}`);
    for (const r of args.resolved.filter((x) => x.status === "obsolete" && x.note.trim() !== "")) lines.push(`- no longer applies: ${r.title} (${r.note.trim()})`);
  }
  const listed = (items: PostedFinding[]) => items.map((f) => `- \`${f.path}:${f.line}\` **[${f.severity}] ${f.title.trim()}**: ${f.body.trim().replace(/\n+/g, " ")}`);
  if (args.offDiff.length > 0) lines.push("", "**Findings outside the diff:**", ...listed(args.offDiff));
  if (args.nits.length > 0) lines.push("", `<details><summary>NITs (${args.nits.length})</summary>`, "", ...listed(args.nits), "", "</details>");
  lines.push("", `_${args.next ?? (args.handoff ? "AI review is done; a human reviewer takes it from here." : "The next AI round runs after new commits are pushed.")}_`, "", "</details>");
  lines.push(`${AI_ROUND_MARKER} ${args.round} -->`);
  return lines.join("\n");
}

/** The deslop pass on your own PR, posted as a folded comment: what it removed, commit by commit, and what it kept. */
export function deslopReportBody(args: { run: number; summary: string; items: { reason: string; commit?: string | null }[]; headBefore: string; headAfter: string | null }): string {
  const cleanups = args.items.filter((i) => (i.commit ?? "") !== "");
  const moved = args.headAfter !== null && args.headAfter !== "" && args.headAfter !== args.headBefore;
  const headline = [
    "<b>Deslop</b>",
    cleanups.length === 0 ? "nothing removed" : `${cleanups.length} cleanup${cleanups.length === 1 ? "" : "s"}`,
    moved ? `<code>${args.headBefore.slice(0, 7)}</code> → <code>${(args.headAfter ?? "").slice(0, 7)}</code>` : null,
  ].filter((x) => x !== null).join(" · ");
  const lines = [`<details><summary>${headline}</summary>`, "", "_Automated deslop of this PR's own diff: duplicate or redundant new structures, one-use abstractions, dead paths, and comments a person would not write, with behavior unchanged._", ""];
  if (args.summary.trim() !== "") lines.push(args.summary.trim(), "");
  for (const i of cleanups) lines.push(`- \`${(i.commit ?? "").slice(0, 10)}\` ${i.reason.trim().replace(/\n+/g, " ")}`);
  lines.push("", "</details>", `${FACTORY_MARKER}deslop ${args.run} -->`);
  return lines.join("\n");
}

// -- babysitter -------------------------------------------------------------

export const BABYSIT_OUTCOMES = ["rerun", "merge_base", "waiting", "needs_human", "ok"] as const;
export type BabysitOutcome = (typeof BABYSIT_OUTCOMES)[number];

export function babysitIntro(c: { owner: string; repo: string; number: number; title: string; worktree: string }): string {
  return [
    `You babysit CI for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}" until it merges. Each message is one pass. Answer each pass with exactly one fenced block tagged ${BABYSIT_FENCE} containing JSON, and nothing after it.`,
    worktreeLine(c.worktree),
    "Hard rules: never edit files, never commit, never push, never merge, never close, never comment on the PR or its threads. The only GitHub write you may make is re-running failed jobs (gh run rerun <run-id> --failed). Review Desk posts what you did on the PR.",
    "Anything that needs a code change or a decision goes back to the human: report needs_human and stop.",
  ].join("\n");
}

export function babysitPrompt(c: { owner: string; repo: string; number: number; headSha: string; baseRef: string; pass: number; maxPasses: number; failing: { name: string; url: string | null }[]; conflicting: boolean; canMergeBase: boolean }): string {
  return [
    `Pass ${c.pass} of at most ${c.maxPasses} at head ${c.headSha} of ${c.owner}/${c.repo}#${c.number}.`,
    c.conflicting ? "GitHub reports merge conflicts with the base branch." : "",
    c.failing.length === 0 ? "No failing checks are reported." : `Failing checks:\n${c.failing.map((f) => `  ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n")}`,
    "",
    "If you have a skill for watching a PR's CI, use it to diagnose; the rules you were given win over it. Otherwise read gh pr checks and gh run view --log-failed.",
    "Decide for each failure what will make it pass:",
    "- A flake, an infra failure, or a cancelled run: re-run the failed jobs (gh run rerun <run-id> --failed), once per pass.",
    c.canMergeBase
      ? `- A failure the branch would not have with the latest ${c.baseRef}: a fix that has landed on ${c.baseRef} since the merge base (check git log <merge-base>..origin/${c.baseRef} for it), or a test that only fails against an old base. Answer merge_base; the author's agent merges ${c.baseRef} into the branch and pushes. Do not merge yourself. Only when ${c.baseRef} actually has what fixes it: merging a base with the same failure does not help.`
      : "",
    "- A failure the PR causes, or one nothing above fixes: needs_human, saying what is wrong and what would fix it.",
    "",
    `Reply with one fenced block tagged ${BABYSIT_FENCE}:`,
    `{ "outcome": "rerun"${c.canMergeBase ? ' | "merge_base"' : ""} | "waiting" | "needs_human" | "ok", "detail": string, "jobs": string[] }`,
    "rerun: you re-ran failed jobs; list them in jobs. waiting: checks are still running and nothing needs doing. ok: nothing is failing. needs_human: as above.",
    "detail: one or two sentences: which check, why it failed, and why your choice will fix it (or what the human must do).",
  ].filter((l) => l !== "").join("\n");
}

const babysitReplySchema = z.object({ outcome: z.enum(BABYSIT_OUTCOMES), detail: z.string().default(""), jobs: z.array(z.string()).default([]) });

export function parseBabysitReply(text: string): { outcome: BabysitOutcome; detail: string; jobs: string[] } {
  return babysitReplySchema.parse(replyJson(text, BABYSIT_FENCE));
}

/** A short PR comment for one thing the factory did to keep CI green, its details folded. */
export function babysitComment(c: { headline: string; detail: string; lines?: string[] }): string {
  const body = [c.detail.trim(), ...(c.lines ?? [])].filter((l) => l !== "");
  return [
    `**CI babysit** · ${c.headline}`,
    ...(body.length > 0 ? ["", "<details><summary>Details</summary>", "", ...body, "", "</details>"] : []),
    `${FACTORY_MARKER}babysit -->`,
  ].join("\n");
}

// -- fixer: your own PRs ------------------------------------------------------
//
// On a PR you wrote, the factory does what you would: after an AI round it
// pulls every comment fresh, judges each, fixes what is worth fixing, pushes,
// and replies on the threads; before your review it deslops the diff. One
// visible thread per PR, working in the PR branch's own worktree.

export const FIX_FENCE = "ai-fix";
export const FIX_VERDICTS = ["FIX", "SKIP", "ASK"] as const;
export type FixVerdict = (typeof FIX_VERDICTS)[number];

export function fixerIntro(c: { owner: string; repo: string; number: number; title: string; headRef: string; worktree: string; remote: string }): string {
  return [
    `You are the author's agent for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}". The author wrote this PR; you act for them. Each message is one job; answer each with exactly one fenced block tagged ${FIX_FENCE} containing JSON, and nothing after it.`,
    `Your working directory is the PR branch's worktree, ${c.worktree}, on branch ${c.headRef}. Push with: git push ${c.remote} HEAD:${c.headRef}.`,
    "Allowed: edit files in this worktree, commit (one logical change per commit, plain messages, no co-author or tool trailers), push to the PR branch, reply on the PR's review threads, and resolve threads that the AI review opened.",
    `When the work needs it you may rebase onto or merge the base branch, resolve conflicts, and reword or squash the PR's own commits; push a rewritten branch with git push --force-with-lease ${c.remote} HEAD:${c.headRef}, never a plain --force. Say in your summary when you did.`,
    "Never: merge the PR itself, push to any branch but the PR's, close or mark the PR ready, resolve threads a human reviewer opened, or touch files outside this worktree.",
    `Before each job, get the worktree clean and current, then carry on: stash uncommitted changes with git stash push -u -m "review-desk: <job>" (say so in your summary; the author can git stash pop them), and bring the branch up to date with ${c.remote}/${c.headRef} (git pull --rebase).`,
  ].join("\n");
}

const FIX_REPLY_SHAPE = [
  `Reply with one fenced block tagged ${FIX_FENCE}:`,
  "{",
  '  "summary": string,   // 2-4 sentences for the author: what you changed and what you left',
  '  "items": [{ "url": string, "author": string, "verdict": "FIX"|"SKIP"|"ASK", "reason": string, "commit"?: string }],   // one per comment or thread you judged; url is its GitHub URL',
  '  "pushed": boolean,',
  '  "head": string        // the branch head after your push (git rev-parse HEAD)',
  "}",
].join("\n");

export function fixPrompt(c: { owner: string; repo: string; number: number; baseSha: string; headSha: string; round: number; reviewUrl: string | null }): string {
  return [
    `Job: triage and fix the feedback on ${c.owner}/${c.repo}#${c.number} after AI review round ${c.round}${c.reviewUrl ? ` (${c.reviewUrl})` : ""}. The PR head is ${c.headSha}; the merge base is ${c.baseSha}.`,
    "",
    "1. Pull every review comment fresh, including AI review threads, human reviewers, and bots: unresolved threads and conversation comments since the last push. If the gh-comment-ledger skill is available, use it to build the ledger.",
    "2. Judge each one on the code at the head, not on the comment's confidence:",
    "   FIX - it is right and worth changing in this PR.",
    "   SKIP - it is wrong, already handled, out of scope, or not worth the churn; say why in one sentence.",
    "   ASK - only the author can decide (design intent, product behavior, a trade-off); say what they need to decide.",
    "3. Fix every FIX item with the smallest change that resolves it, one commit per item (or per group of items that are one change). Run the narrowest checks that prove each fix: the touched crate's or package's tests, the type checker, the linter; use the repository's own skills and guidance for how to build and test. Do not run GPU or load tests.",
    "4. Push once at the end.",
    "5. Reply on each thread you judged: \"Fixed in <short sha>: <what changed>\" for FIX, the reason for SKIP, and the question for ASK. Resolve the AI review's threads you fixed; leave human reviewers' threads for them to resolve.",
    "",
    FIX_REPLY_SHAPE,
  ].join("\n");
}

export function deslopPrompt(c: { owner: string; repo: string; number: number; baseSha: string; headSha: string }): string {
  return [
    `Job: deslop ${c.owner}/${c.repo}#${c.number} before the author reviews it. The PR's own changes are git diff ${c.baseSha}..HEAD (head ${c.headSha}).`,
    "Use the deslop skill on that diff: merge duplicate or redundant new types and structures, inline structures and helpers with one use, remove dead paths, defensive noise, and comments a person would not write, and keep behavior exactly. One cleanup per commit, the narrowest checks after each, then push once.",
    "If nothing is worth removing, change nothing and say so.",
    "",
    `Reply with one fenced block tagged ${FIX_FENCE}: { "summary": string, "items": [{ "url": "", "author": "deslop", "verdict": "FIX", "reason": string, "commit": string }], "pushed": boolean, "head": string }, one item per cleanup commit.`,
  ].join("\n");
}

export function syncPrompt(c: { owner: string; repo: string; number: number; baseRef: string; baseRemote: string; reason: string }): string {
  return [
    `Job: bring ${c.baseRef} into ${c.owner}/${c.repo}#${c.number}'s branch, because ${c.reason}.`,
    `git fetch ${c.baseRemote} ${c.baseRef}, then git merge --no-edit ${c.baseRemote}/${c.baseRef}. Merge, do not rebase: nothing pushed gets rewritten.`,
    `Resolve every conflict by keeping both intents: what this PR changes and what ${c.baseRef} changed. Read both sides (git log and the diff of ${c.baseRef} for the conflicted files) before choosing. Then build and run the narrowest checks for the files you touched, commit the merge, and push.`,
    "If a conflict needs a decision only the author can make, abort the merge (git merge --abort) and report ASK for it.",
    "",
    `Reply with one fenced block tagged ${FIX_FENCE}: { "summary": string, "items": [{ "url": "", "author": "sync", "verdict": "FIX"|"ASK", "reason": string, "commit": string }], "pushed": boolean, "head": string }, one item per conflicted file saying how you resolved it (none when the merge was clean), with the merge commit.`,
  ].join("\n");
}

const fixReplySchema = z.object({
  summary: z.string().default(""),
  items: z
    .array(z.object({ url: z.string().default(""), author: z.string().default(""), verdict: z.string(), reason: z.string().default(""), commit: z.string().nullable().optional() }))
    .default([]),
  pushed: z.boolean().default(false),
  head: z.string().default(""),
});
export type FixReply = z.infer<typeof fixReplySchema>;

export function parseFixReply(text: string): FixReply {
  const reply = fixReplySchema.parse(replyJson(text, FIX_FENCE));
  return { ...reply, items: reply.items.map((i) => ({ ...i, verdict: (FIX_VERDICTS as readonly string[]).includes(i.verdict.toUpperCase()) ? i.verdict.toUpperCase() : "ASK" })) };
}
