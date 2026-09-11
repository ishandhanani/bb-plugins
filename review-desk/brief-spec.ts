// Shared between server.ts and app.tsx: the Brief the helper thread writes
// about a PR (plain-English summary, areas, claims checked against the diff,
// and its own reading of how much the PR looks like unedited AI output).

export type ClaimVerdict = "matches" | "partly" | "no-evidence" | "contradicted";

export interface BriefEvidence {
  path: string;
  line: number | null;
  /** False when the path is not in this PR's diff. */
  found: boolean;
}

export interface BriefArea {
  module: string;
  what: string;
  path: string | null;
}

export interface BriefClaim {
  claim: string;
  verdict: ClaimVerdict;
  evidence: BriefEvidence[];
  note: string;
}

export interface BriefReason {
  reason: string;
  evidence: BriefEvidence[];
}

export interface Brief {
  summary: string;
  areas: BriefArea[];
  claims: BriefClaim[];
  ai: { score: number; reasons: BriefReason[] };
}

export const BRIEF_FENCE = "review-brief";
