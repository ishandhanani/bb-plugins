// The PR factory, shared by server.ts and app.tsx: labels, reply parsing, the
// thread intros, and what the factory posts to GitHub. The stage prompts are
// files (prompts/*.md, built in factory-prompts.ts); the wiring is in server.ts.
import { z } from "zod";

/** What a finding is, in the order a reviewer should read them. Only NIT never holds up a merge. */
export const AI_LABELS = ["BLOCKER", "BUG", "PERF", "TEST", "DESIGN", "QUESTION", "NIT"] as const;
export type AiLabel = (typeof AI_LABELS)[number];

export const AI_LABEL_MEANING: Record<AiLabel, string> = {
  BLOCKER: "must be fixed before merge: wrong results, a crash, data loss, a security hole, or a broken contract on a common path",
  BUG: "a real bug on a less common path",
  PERF: "work a request, token, event, or connection pays that it did not pay on the base branch: allocations, clones, locks, scans, serialization; the cost argument is enough, a measurement is not required",
  TEST: "risky logic with no test, or a test that does not check what it claims",
  DESIGN: "structure, API, or naming that will cause bugs or make the code hard to change",
  QUESTION: "something only the author can answer; the review cannot tell whether it is right",
  NIT: "style, naming, comments, small cleanups, small costs; never holds up a merge on its own, and is still posted",
};

export function normalizeLabel(value: string): AiLabel {
  const upper = value.trim().toUpperCase();
  return (AI_LABELS as readonly string[]).includes(upper) ? (upper as AiLabel) : "BUG";
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

const aiReplySchema = z.object({
  summary: z.string().default(""),
  read: z.array(z.string()).default([]),
  /** The reviewer's own call on whether this round's code touches a request path, so a performance review should follow. */
  perf: z.object({ needed: z.boolean().default(false), why: z.string().default("") }).nullable().optional(),
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
export function replyJson(text: string, fence: string): unknown {
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

/** Whether a thread's last message carries the job's reply block at all; a turn that ended early (waiting on a background job) does not. */
export function hasReply(text: string | null, fence: string): boolean {
  if (text === null) return false;
  try {
    const value = replyJson(text, fence);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
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
export function findingHeader(severity: string, title: string, round: number, perf = false): string {
  return `**[${severity}] ${title.trim()}** (${perf ? `AI perf review, round ${round}` : `AI review, round ${round}`})`;
}

/** Matches the first line of any thread the factory opened. */
export const FACTORY_THREAD = /\(AI (perf )?review, round \d+\)/;

export function findingComment(f: PostedFinding, round: number, perf = false): string {
  const parts = [findingHeader(f.severity, f.title, round, perf), f.body.trim()];
  if (f.suggestion !== null && f.suggestion.trim() !== "") parts.push("```suggestion\n" + f.suggestion.replace(/^```\w*\n?|```$/g, "").replace(/\n$/, "") + "\n```");
  return parts.filter((p) => p !== "").join("\n\n");
}

/** The review body: header, summary, what happened to earlier findings, and what could not go inline. */
export function reviewBody(args: {
  round: number;
  /** A perf review posts beside the round's code review. */
  perf?: boolean;
  /** The skill and AGENTS.md files the reviewer read. */
  read?: string[];
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
  const headline = [`<b>Round ${args.round} AI ${args.perf ? "perf review" : "review"}</b>`, tally.length === 0 ? "no new findings" : tally.join(", "), earlier].filter((x) => x !== null).join(" · ");
  const lines = [`<details><summary>${headline}</summary>`, "", `_Automated ${args.perf ? "performance review" : "review"}, round ${args.round}. Every finding is posted, NITs included; findings may be wrong, so reply on a thread to dispute one._`, ""];
  if (args.summary.trim() !== "") lines.push(args.summary.trim(), "");
  if ((args.read ?? []).length > 0) lines.push(`Read: ${(args.read ?? []).slice(0, 30).join(", ")}`, "");
  if (earlier !== null) {
    lines.push(`**Earlier findings:** ${fixed} fixed, ${obsolete} no longer apply, ${args.stillOpen.length} still open`);
    for (const r of args.stillOpen) lines.push(`- still open **[${normalizeLabel(r.severity)}]** ${r.title}`);
    for (const r of args.resolved.filter((x) => x.status === "obsolete" && x.note.trim() !== "")) lines.push(`- no longer applies: ${r.title} (${r.note.trim()})`);
  }
  const listed = (items: PostedFinding[]) => items.map((f) => `- \`${f.path}:${f.line}\` **[${f.severity}] ${f.title.trim()}**: ${f.body.trim().replace(/\n+/g, " ")}`);
  if (args.offDiff.length > 0) lines.push("", "**Findings outside the diff:**", ...listed(args.offDiff));
  if (args.nits.length > 0) lines.push("", `<details><summary>NITs (${args.nits.length})</summary>`, "", ...listed(args.nits), "", "</details>");
  lines.push("", `_${args.next ?? (args.handoff ? "AI review is done at this head; a human reviewer takes it from here." : "The next AI round runs after new commits are pushed.")}_`, "", "</details>");
  lines.push(`${AI_ROUND_MARKER} ${args.round}${args.perf ? " perf" : ""} -->`);
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

export const BABYSIT_OUTCOMES = ["rerun", "merge_base", "fix", "waiting", "blocked", "needs_human", "ok"] as const;
export type BabysitOutcome = (typeof BABYSIT_OUTCOMES)[number];

export function babysitIntro(c: { owner: string; repo: string; number: number; title: string; worktree: string }): string {
  return [
    `You babysit CI for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}" until it merges. Each message is one pass. Answer each pass with exactly one fenced block tagged ${BABYSIT_FENCE} containing JSON, and nothing after it.`,
    worktreeLine(c.worktree),
    "Hard rules: never edit files, never commit, never push, never merge, never close, never write on the PR's review threads. The GitHub writes you may make are re-running failed jobs (gh run rerun <run-id> --failed) and the CI commands the repository's guide names (for example a slash command posted as a PR comment that starts or re-runs CI). Review Desk posts what you did on the PR.",
    "You never change code yourself. A failure that needs a code change, or the base branch merged in, is done by another agent when you report it (outcome fix or merge_base); you say which. A person is asked only when nothing else can move the PR.",
    "Wait for what you start: do not end your turn while a command you started is still running in the background.",
  ].join("\n");
}

const babysitReplySchema = z.object({
  outcome: z.enum(BABYSIT_OUTCOMES),
  cause: z.string().default(""),
  detail: z.string().default(""),
  jobs: z.array(z.string()).default([]),
  expected: z.array(z.string()).default([]),
  fixedBy: z.array(z.union([z.string(), z.number()])).default([]),
});

/** The pull request numbers a babysit pass named as the fix, read from numbers, "#123", or PR URLs. */
function prNumbers(values: (string | number)[]): number[] {
  const out = new Set<number>();
  for (const v of values) {
    const n = typeof v === "number" ? v : Number(/(?:\/pull\/|#|^)(\d+)\b/.exec(v.trim())?.[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

export function parseBabysitReply(text: string): { outcome: BabysitOutcome; cause: string; detail: string; jobs: string[]; expected: string[]; fixedBy: number[] } {
  const reply = babysitReplySchema.parse(replyJson(text, BABYSIT_FENCE));
  return { ...reply, cause: reply.cause.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200), fixedBy: prNumbers(reply.fixedBy) };
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

export function fixerIntro(c: { owner: string; repo: string; number: number; title: string; headRef: string; worktree: string; remote: string; mine?: boolean }): string {
  return [
    c.mine === false
      ? `You keep CI green on pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}", for a maintainer of the repository. Someone else wrote this PR. Your jobs are only to merge the base branch in and to fix what makes CI fail; never change what the PR does, and never answer its review comments. Each message is one job; answer each with exactly one fenced block tagged ${FIX_FENCE} containing JSON, and nothing after it.`
      : `You are the author's agent for pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}". The author wrote this PR; you act for them. Each message is one job; answer each with exactly one fenced block tagged ${FIX_FENCE} containing JSON, and nothing after it.`,
    `Your working directory is the PR branch's worktree, ${c.worktree}, on branch ${c.headRef}. Push with: git push ${c.remote} HEAD:${c.headRef}.`,
    "Allowed: edit files in this worktree, commit (one logical change per commit, plain messages, no co-author or tool trailers), push to the PR branch when a job tells you to, reply on the PR's review threads, and resolve threads that the AI review or a bot opened.",
    "A fix job has two steps. First you commit without pushing; a separate check reads your commits. When it passes you are told to push and reply on the threads. Never push before you are told to.",
    `When the work needs it you may rebase onto or merge the base branch, resolve conflicts, and reword or squash the PR's own commits; push a rewritten branch with git push --force-with-lease ${c.remote} HEAD:${c.headRef}, never a plain --force. Say in your summary when you did.`,
    "Never: merge the PR itself, push to any branch but the PR's, close the PR, mark it ready, request reviewers, resolve threads a human reviewer opened, or touch files outside this worktree.",
    "Wait for what you start: when a build or a test runs in the background, wait for it in the foreground until it finishes. Your last message is read as the end of the job, so never end a turn with work still running.",
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

// -- check: the author's agent's commits, before they are pushed -----------------
//
// A reviewer that has never seen the PR reads the commits the author's agent
// made (a fix, a deslop, a CI fix) and argues against pushing each one. What it
// rejects goes back to the agent once; a second rejection goes to you.

export const CHECK_FENCE = "ai-check";

export function checkerIntro(c: { owner: string; repo: string; number: number; title: string; worktree: string }): string {
  return [
    `You check the author's agent's commits on pull request #${c.number} of ${c.owner}/${c.repo}: "${c.title}", before they are pushed. Each message is one check. Answer each with exactly one fenced block tagged ${CHECK_FENCE} containing JSON, and nothing after it.`,
    `The commits are local, in the PR branch's worktree: ${c.worktree}. Run every command there: cd ${c.worktree} && <command>, or git -C ${c.worktree} <args>.`,
    "You never commit, never push, and never post to GitHub. You may run tests, and revert a change locally to see whether a test fails without it; leave the worktree exactly as you found it (same HEAD, no uncommitted change).",
  ].join("\n");
}

const checkReplySchema = z.object({
  summary: z.string().default(""),
  verdicts: z.array(z.object({ commit: z.string().default(""), verdict: z.string(), reason: z.string().default("") })).default([]),
});
export interface CheckVerdict { commit: string; verdict: "PASS" | "REJECT"; reason: string }

export function parseCheckReply(text: string): { summary: string; verdicts: CheckVerdict[] } {
  const reply = checkReplySchema.parse(replyJson(text, CHECK_FENCE));
  return { summary: reply.summary, verdicts: reply.verdicts.map((v) => ({ commit: v.commit.trim(), verdict: v.verdict.trim().toUpperCase() === "REJECT" ? "REJECT" : "PASS", reason: v.reason.trim() })) };
}

// -- learn: after a merge, human comments against AI findings --------------------

export const LEARN_FENCE = "ai-learn";
export const LEARN_MATCHES = ["found", "demoted", "missed"] as const;
export type LearnMatch = (typeof LEARN_MATCHES)[number];

const learnReplySchema = z.object({
  summary: z.string().default(""),
  items: z
    .array(z.object({ url: z.string().default(""), author: z.string().default(""), category: z.string().default(""), match: z.string(), finding: z.string().default(""), cause: z.string().default(""), home: z.string().default(""), rule: z.string().default("") }))
    .default([]),
});
export type LearnItem = Omit<z.infer<typeof learnReplySchema>["items"][number], "match"> & { match: LearnMatch };

export function parseLearnReply(text: string): { summary: string; items: LearnItem[] } {
  const reply = learnReplySchema.parse(replyJson(text, LEARN_FENCE));
  return {
    summary: reply.summary,
    items: reply.items.map((i) => ({ ...i, match: (LEARN_MATCHES as readonly string[]).includes(i.match.toLowerCase()) ? (i.match.toLowerCase() as LearnMatch) : "missed" })),
  };
}
