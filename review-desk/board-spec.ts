// The board over tracked pull requests, shared by server.ts and app.tsx.
//
// You add a PR to the board; that starts the factory. An open PR then sits in
// the column its auto stage says: Babysit once anyone approves it on GitHub,
// otherwise the PR factory's stage, otherwise GitHub's state. You can drag a
// card somewhere else; a dragged card holds its column until the auto stage
// changes, then follows it again. A merged or closed PR leaves the columns
// (stage null) and waits in the "merged or closed" strip until you remove it.
//
// The factory is one loop: Review -> Fix and check -> Review, until the head a
// round reviewed is the PR's current head and nothing above a nit is open.
// Then the PR is ready for you. Nothing requests reviewers for you.
export const BOARD_STAGES = ["unreviewed", "ai_review", "fixing", "human_review", "changes_requested", "babysit"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export const BOARD_STAGE_LABEL: Record<BoardStage, string> = {
  unreviewed: "Not started",
  ai_review: "Review",
  fixing: "Fix and check",
  human_review: "Your review",
  changes_requested: "Changes requested",
  babysit: "Babysit",
};

export const BOARD_STAGE_HINT: Record<BoardStage, string> = {
  unreviewed: "On the board, with the factory off",
  ai_review: "AI review of every pushed head: the whole PR first, then what changed; a perf review when the diff touches a request path. Every finding is posted",
  fixing: "Your PR: the author's agent fixes the feedback, a fresh-context check argues against each commit, and only then is anything pushed",
  human_review: "AI review is done at the current head; your turn to approve or comment",
  changes_requested: "A reviewer asked for changes; waiting on the author",
  babysit: "Approved by you or others; watch CI until it merges",
};

export function isBoardStage(value: unknown): value is BoardStage {
  return typeof value === "string" && (BOARD_STAGES as readonly string[]).includes(value);
}

/** The stages the PR factory drives. Not started comes from GitHub; Babysit comes from an approval, or from the loop finishing on your own PR. */
export const PIPELINE_STAGES = ["ai_review", "fixing", "human_review", "changes_requested", "babysit"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/**
 * The board's two rows. Your own PRs run the whole loop and end in Babysit (or
 * in Needs you, when only you can unblock them); everyone else's are reviewed
 * and handed to you.
 */
export const BOARD_LANES = [
  { id: "mine", label: "My PRs", stages: ["unreviewed", "ai_review", "fixing", "human_review", "babysit"] },
  { id: "reviewing", label: "Reviewing", stages: ["unreviewed", "ai_review", "human_review", "changes_requested", "babysit"] },
] as const satisfies readonly { id: string; label: string; stages: readonly BoardStage[] }[];
export type BoardLane = (typeof BOARD_LANES)[number]["id"];

/** Column names that read differently in a lane. */
export function stageLabel(stage: BoardStage, lane: BoardLane): string {
  if (lane === "mine" && stage === "human_review") return "Needs you";
  return BOARD_STAGE_LABEL[stage];
}

/** What a column means in a lane, for its tooltip and its empty state. */
export function stageHint(stage: BoardStage, lane: BoardLane): string {
  if (lane === "mine" && stage === "human_review") return "Only you can unblock these: a question from the author's agent, a commit the check rejected twice, or a job that stopped";
  if (lane === "mine" && stage === "babysit") return "Reviewed at the current head, nothing above a nit open. CI is babysat; request reviewers when you want. A new push, or a reviewer's comments, sends it back through the loop";
  return BOARD_STAGE_HINT[stage];
}
