// The board over tracked pull requests, shared by server.ts and app.tsx.
//
// An open PR sits in the column its auto stage says: Babysit once anyone
// approves it on GitHub, otherwise the PR factory's stage (AI review, Human
// review, Changes requested), otherwise GitHub's state. You can drag a card
// somewhere else; a dragged card holds its column until the auto stage
// changes, then follows it again. A merged or closed PR leaves the columns
// (stage null) and waits in the "merged or closed" strip until you remove it.
export const BOARD_STAGES = ["unreviewed", "ai_review", "fixing", "deslop", "final_check", "human_review", "changes_requested", "babysit"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export const BOARD_STAGE_LABEL: Record<BoardStage, string> = {
  unreviewed: "Unreviewed",
  ai_review: "AI review",
  fixing: "Fixing",
  deslop: "Deslop",
  final_check: "Final check",
  human_review: "Human review",
  changes_requested: "Changes requested",
  babysit: "Babysit",
};

export const BOARD_STAGE_HINT: Record<BoardStage, string> = {
  unreviewed: "Open; no review has started",
  ai_review: "AI review rounds; the next round runs when new commits land",
  fixing: "Your PR: the author's agent triages the feedback, fixes what is worth fixing, and pushes",
  deslop: "Your PR: the author's agent strips what the diff does not need before you look",
  final_check: "A reviewer that never saw the PR reviews all of it; a second model with its full history tries to refute each finding",
  human_review: "AI review is done; your turn to approve or comment",
  changes_requested: "A reviewer asked for changes; waiting on the author",
  babysit: "Approved by you or others; watch CI until it merges",
};

export function isBoardStage(value: unknown): value is BoardStage {
  return typeof value === "string" && (BOARD_STAGES as readonly string[]).includes(value);
}

/** The stages the PR factory drives. Unreviewed comes from GitHub; Babysit comes from an approval, or from the pipeline on your own PR. */
export const PIPELINE_STAGES = ["ai_review", "fixing", "deslop", "final_check", "human_review", "changes_requested", "babysit"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/**
 * The board's two rows. Your own PRs run the author's pipeline (AI review,
 * fixing, deslop, your review); everyone else's run the reviewer's.
 */
export const BOARD_LANES = [
  { id: "mine", label: "My PRs", stages: ["unreviewed", "ai_review", "fixing", "deslop", "final_check", "human_review", "babysit"] },
  { id: "reviewing", label: "Reviewing", stages: ["unreviewed", "ai_review", "final_check", "human_review", "changes_requested", "babysit"] },
] as const satisfies readonly { id: string; label: string; stages: readonly BoardStage[] }[];
export type BoardLane = (typeof BOARD_LANES)[number]["id"];

/** Column names that read differently in a lane. */
export function stageLabel(stage: BoardStage, lane: BoardLane): string {
  return lane === "mine" && stage === "human_review" ? "Your review" : BOARD_STAGE_LABEL[stage];
}
