// Shared between server.ts and app.tsx: the diagram spec the illustrator
// returns and the plugin renders. Nodes carry a `ref` (a path, `path:10-20`,
// or a symbol name) that the server resolves against the PR so every node
// that corresponds to code can jump to it in the diff.

export type DiagramKind = "graph" | "layers" | "sequence";
export type ChangeStatus = "added" | "modified" | "removed" | "unchanged";

/** Where a node or step points in the PR, after the server resolved its `ref`. */
export interface DiagramRef {
  path: string;
  startLine: number | null;
  endLine: number | null;
  side: "old" | "new";
  /** Human label: the symbol name or `file:lines`. */
  label: string;
  /** False when the ref names something that is not in this PR's diff. */
  found: boolean;
}

export interface DiagramGroup {
  id: string;
  label: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  group?: string;
  /** Explicit row for `layers` diagrams; 0 is the top. */
  tier?: number;
  ref?: string;
  resolved?: DiagramRef | null;
  status?: ChangeStatus;
  note?: string;
  stats?: { additions: number; deletions: number };
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  status?: ChangeStatus;
}

/** One arrow in a `sequence` diagram; `from`/`to` are lane (node) ids. */
export interface DiagramStep {
  from: string;
  to: string;
  label: string;
  ref?: string;
  resolved?: DiagramRef | null;
  status?: ChangeStatus;
  note?: string;
}

export interface DiagramSpec {
  title: string;
  kind: DiagramKind;
  summary?: string;
  groups?: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  steps?: DiagramStep[];
}

export const DIAGRAM_FENCE = "review-diagram";
export const DIAGRAM_LIMITS = { nodes: 60, groups: 10, edges: 120, steps: 60 };

export type DiagramPreset = "architecture" | "flow" | "data" | "file" | "custom";

export const PRESET_LABELS: Record<DiagramPreset, string> = {
  architecture: "Architecture, before and after",
  flow: "Flow through the selected lines",
  data: "Data model touched",
  file: "What changed in a file",
  custom: "Custom",
};
