// The board over tracked pull requests, shared by server.ts and app.tsx.
//
// A card sits in the column GitHub's state puts it in (its auto stage) unless
// you drag it somewhere else; a dragged card holds its column until GitHub's
// state changes, then follows GitHub again.
export const BOARD_STAGES = ["unreviewed", "changes_requested", "approved", "done"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export const BOARD_STAGE_LABEL: Record<BoardStage, string> = {
  unreviewed: "Unreviewed",
  changes_requested: "Changes requested",
  approved: "Approved",
  done: "Done",
};

export const BOARD_STAGE_HINT: Record<BoardStage, string> = {
  unreviewed: "Open; GitHub still wants a review",
  changes_requested: "A reviewer asked for changes",
  approved: "Approved on GitHub, waiting to merge",
  done: "Merged or closed",
};

export function isBoardStage(value: unknown): value is BoardStage {
  return typeof value === "string" && (BOARD_STAGES as readonly string[]).includes(value);
}
