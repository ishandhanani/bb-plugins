// The board over tracked pull requests, shared by server.ts and app.tsx.
//
// An open PR sits in the column GitHub's state puts it in (its auto stage)
// unless you drag it somewhere else; a dragged card holds its column until
// GitHub's state changes, then follows GitHub again. A merged or closed PR
// leaves the columns (stage null) and waits in the "merged or closed" strip
// until you remove it.
export const BOARD_STAGES = ["unreviewed", "changes_requested", "babysit"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export const BOARD_STAGE_LABEL: Record<BoardStage, string> = {
  unreviewed: "Unreviewed",
  changes_requested: "Changes requested",
  babysit: "Babysit",
};

export const BOARD_STAGE_HINT: Record<BoardStage, string> = {
  unreviewed: "Open; nobody has approved yet",
  changes_requested: "A reviewer asked for changes",
  babysit: "Approved by you or others; watch CI until it merges",
};

export function isBoardStage(value: unknown): value is BoardStage {
  return typeof value === "string" && (BOARD_STAGES as readonly string[]).includes(value);
}
