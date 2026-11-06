// Block Kit for the Slack bridge: each PR's card (the root of its thread),
// and the replies the factory posts in that thread. Pure
// functions of Review Desk's data; slack-bridge in server.ts posts them.

import { BOARD_LANES, stageLabel } from "./board-spec";
import { AI_LABELS, isHighValue, type AiLabel } from "./factory-spec";
import type { FixRun, ReviewSummary } from "./server";

type Block = Record<string, unknown>;

/** Slack's mrkdwn escapes: &, <, and > only. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);
const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const plain = (text: string) => ({ type: "plain_text", text });
const richText = (text: string, link?: string): Block => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [link ? { type: "link", text, url: link } : { type: "text", text }] }],
});
// Slack refuses a table cell with empty text.
const cell = (text: string, link?: string): Block => (link ? richText(text || "-", link) : { type: "raw_text", text: text || "-" });

export function prStage(card: ReviewSummary): string {
  if (card.stage === null) return card.state === "MERGED" ? "Merged" : "Closed";
  return stageLabel(card.stage, card.mine ? "mine" : "reviewing");
}

export function ciLine(card: ReviewSummary): string {
  const c = card.checks;
  if (c.total === 0) return "no checks yet";
  if (c.failed > 0) return `CI failing ${c.failed}/${c.total}`;
  if (c.pending > 0) return `CI running ${c.passed}/${c.total}`;
  return `CI green ${c.passed}/${c.total}`;
}

/** What is happening or needed now, in a few words. */
export function nowLine(card: ReviewSummary): string {
  const f = card.factory;
  if (f?.needsYou) return `needs you: ${f.needsYou}`;
  if (f?.fix?.status === "running") return `${f.fix.kind === "deslop" ? "deslopping" : f.fix.kind === "sync" ? "merging the base" : "fixing"}`;
  if (f?.roundStatus === "running" || f?.roundStatus === "queued") return `AI round ${f.round} ${f.roundStatus}`;
  if (card.mergeable === "CONFLICTING") return "merge conflicts";
  return "";
}

/** The PR's path through its lane, the current stage in bold: AI review › Fixing › *Deslop* › Babysit. */
export function stagePath(card: ReviewSummary): string {
  if (card.stage === null) return `*${prStage(card)}*`;
  const lane = BOARD_LANES.find((l) => l.id === (card.mine ? "mine" : "reviewing"));
  const stages = (lane?.stages ?? []).filter((s) => s !== "unreviewed" && (s !== "changes_requested" || card.stage === s));
  if (!stages.includes(card.stage as never)) return `*${prStage(card)}*`;
  return stages.map((s) => (s === card.stage ? `*${stageLabel(s, card.mine ? "mine" : "reviewing")}*` : stageLabel(s, card.mine ? "mine" : "reviewing"))).join(" › ");
}

/** The root of a PR's thread: one card, repainted as the PR moves. */
export function prCard(card: ReviewSummary): { text: string; blocks: Block[] } {
  const now = nowLine(card);
  const text = `${card.owner}/${card.repo}#${card.number} ${card.title} · ${prStage(card)}`;
  return {
    text,
    blocks: [
      {
        type: "card",
        title: mrkdwn(clip(`*<${card.url}|#${card.number}>* ${esc(card.title)}`, 150)),
        subtitle: mrkdwn(clip(`${card.owner}/${card.repo}${card.author ? ` · ${esc(card.author)}` : ""}${card.isDraft ? " · draft" : ""}`, 150)),
        body: mrkdwn(clip(`${stagePath(card)}\n${ciLine(card)}${card.unresolvedThreads > 0 ? ` · ${card.unresolvedThreads} open thread${card.unresolvedThreads === 1 ? "" : "s"}` : ""}`, 200)),
        ...(now ? { subtext: mrkdwn(clip(esc(now), 200)) } : {}),
        actions: [{ type: "button", text: plain("Open PR"), url: card.url, action_id: "rd_open" }],
      },
    ],
  };
}

/** An AI round, posted in the PR's thread: the tally and a table of what is worth reading. */
export function roundReply(c: { round: number; counts: Record<AiLabel, number>; findings: { severity: string; path: string; line: number; title: string }[]; reviewUrl: string | null }): { text: string; blocks: Block[] } {
  const tally = AI_LABELS.filter((l) => c.counts[l] > 0).map((l) => `${c.counts[l]} ${l}`).join(", ") || "no findings";
  const worth = c.findings.filter((f) => isHighValue(f.severity)).slice(0, 30);
  const head = `*Round ${c.round} AI review* · ${tally}${c.reviewUrl ? ` · <${c.reviewUrl}|review>` : ""}`;
  return {
    text: `Round ${c.round} AI review: ${tally}`,
    blocks: [
      { type: "section", text: mrkdwn(head) },
      ...(worth.length > 0
        ? [{ type: "table", column_settings: [{}, {}, { is_wrapped: true }], rows: [[cell("Label"), cell("Where"), cell("Finding")], ...worth.map((f) => [cell(f.severity), cell(clip(`${f.path}:${f.line}`, 80)), cell(clip(f.title, 160))])] }]
        : []),
    ],
  };
}

const KIND_TITLE: Record<string, string> = { fix: "Fixing", deslop: "Deslop", sync: "Merging the base" };

/** The author's agent's run as a plan: one task while it works, one per verdict when done. */
export function fixRunReply(run: FixRun, prNumber: number): { text: string; blocks: Block[] } {
  const title = `${KIND_TITLE[run.kind] ?? run.kind} · run ${run.run}`;
  if (run.status === "running") {
    return { text: `#${prNumber} ${title}: working`, blocks: [{ type: "plan", title, tasks: [{ task_id: "work", title: "Working on it", status: "in_progress" }] }] };
  }
  if (run.status === "failed") {
    return { text: `#${prNumber} ${title}: stopped`, blocks: [{ type: "plan", title, tasks: [{ task_id: "work", title: "Stopped", status: "error", output: richText(clip(run.error ?? "unknown error", 1_500)) }] }] };
  }
  const tasks = run.items.slice(0, 48).map((item, i) => ({
    task_id: `item_${i}`,
    title: clip(`${item.verdict === "SKIP" ? "Skipped" : item.verdict === "ASK" ? "Needs you" : "Done"}: ${item.reason.split("\n")[0]}`, 180),
    status: item.verdict === "ASK" ? "error" : "complete",
    ...(item.commit ? { output: richText(`commit ${item.commit.slice(0, 10)}`) } : item.url ? { output: richText("thread", item.url) } : {}),
  }));
  if (tasks.length === 0) tasks.push({ task_id: "none", title: run.kind === "deslop" ? "Nothing worth removing" : "Nothing to change", status: "complete" });
  const moved = run.headAfter && run.headAfter !== run.headBefore ? ` · pushed ${run.headAfter.slice(0, 7)}` : "";
  return {
    text: `#${prNumber} ${title}${moved}`,
    blocks: [{ type: "plan", title: `${title}${moved}`, tasks }, ...(run.summary ? [{ type: "context", elements: [mrkdwn(clip(esc(run.summary), 2_900))] }] : [])],
  };
}

/** One thing the babysitter did (a re-run, a merge), as a finished task. */
export function babysitReply(headline: string, detail: string): { text: string; blocks: Block[] } {
  return {
    text: `CI babysit: ${headline}`,
    blocks: [{ type: "task_card", task_id: "babysit", title: clip(`CI babysit · ${headline.replace(/`/g, "")}`, 180), status: "complete", ...(detail ? { output: richText(clip(detail, 2_900)) } : {}) }],
  };
}

/** A hand-off: the only factory reply that mentions you. */
export function handoffReply(headline: string, why: string, userId: string | null): { text: string; blocks: Block[] } {
  const who = userId ? `<@${userId}> ` : "";
  return { text: `${headline}: ${why}`, blocks: [{ type: "section", text: mrkdwn(`${who}*${esc(headline)}*: ${esc(clip(why, 2_800))}`) }] };
}

/** An agent's answer: markdown blocks of at most 12,000 characters each (Slack renders the model's Markdown). */
export function agentReply(text: string): { text: string; blocks: Block[] } {
  const chunks: string[] = [];
  for (let rest = text.trim(); rest.length > 0; rest = rest.slice(11_000)) chunks.push(rest.slice(0, 11_000));
  return { text: clip(text.trim(), 3_000), blocks: chunks.slice(0, 4).map((chunk) => ({ type: "markdown", text: chunk })) };
}

