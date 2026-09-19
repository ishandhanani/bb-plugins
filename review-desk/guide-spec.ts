// Shared between server.ts and app.tsx: the Guide the helper thread writes on
// top of the codemap. The codemap says which symbols changed where; the guide
// says what the change is, how the changed code runs, in what order to read
// the files, and what each file does in this PR.

export type GuideRole = "core" | "types" | "wiring" | "tests" | "docs" | "config" | "generated" | "moved";

export const GUIDE_ROLES: readonly GuideRole[] = ["core", "types", "wiring", "tests", "docs", "config", "generated", "moved"];

export interface GuideFile {
  path: string;
  role: GuideRole;
  /** One sentence: what this file does in this PR. */
  what: string;
  /** Mechanical change (rename, import shuffle, lockfile, formatting): safe to pass quickly. */
  skim: boolean;
}

/** One hop of the runtime path through the changed code. */
export interface GuideHop {
  path: string;
  symbol: string;
  what: string;
  /** Head line of the symbol, when the codemap has it. */
  line: number | null;
}

export interface GuideStep {
  title: string;
  /** What happens in this group and why it is read at this point. */
  why: string;
  /** Changed files, in the order to read them. */
  paths: string[];
}

export interface Guide {
  /** High level: what the PR does and the shape of the change. */
  overview: string;
  /** Mid level: the runtime path through the changed code, in call order. */
  flow: GuideHop[];
  /** The reading order. Every changed file is in exactly one step. */
  steps: GuideStep[];
  /** One line per changed file. */
  files: GuideFile[];
}

export const GUIDE_FENCE = "review-guide";
