// Shared between server.ts and app.tsx: the Brief the helper thread writes
// about a PR (a plain-English summary as bullets, and the areas it touches).

export interface BriefArea {
  module: string;
  what: string;
  path: string | null;
}

export interface Brief {
  /** Markdown: one bullet per behavior change, written from the diff. */
  summary: string;
  areas: BriefArea[];
}

export const BRIEF_FENCE = "review-brief";
