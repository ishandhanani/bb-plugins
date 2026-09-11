// Shared between server.ts and app.tsx: the identity of one "code pill".
//
// A pill is a bb @-mention that resolves through this plugin's mention
// provider at send time. The frontend creates pills from diff selections and
// file cards; the server creates them from `@` searches and resolves any of
// them to text for the analyst. Both sides must agree on the id encoding, so
// it lives here. Ids are JSON so paths with any characters round-trip.

export const MENTION_PROVIDER_ID = "code";

export type MentionRef =
  | { kind: "range"; reviewId: string; path: string; startLine: number; endLine: number; side: "old" | "new" }
  | { kind: "file"; reviewId: string; path: string }
  | { kind: "symbol"; reviewId: string; path: string; qualified: string; startLine: number; endLine: number; side: "old" | "new" }
  | { kind: "thread"; reviewId: string; threadId: string }
  | { kind: "pr"; reviewId: string }
  /** One commit of the PR: message, stat, and patch. */
  | { kind: "commit"; reviewId: string; sha: string }
  /** Lines of a file as they were at one commit (the commit view's selection). */
  | { kind: "crange"; reviewId: string; sha: string; path: string; startLine: number; endLine: number };

export function encodeMentionRef(ref: MentionRef): string {
  return JSON.stringify(ref);
}

export function decodeMentionRef(id: string): MentionRef | null {
  try {
    const value = JSON.parse(id) as Partial<MentionRef> & { kind?: string };
    if (typeof value !== "object" || value === null || typeof value.reviewId !== "string") return null;
    switch (value.kind) {
      case "range":
      case "file":
      case "symbol":
      case "thread":
      case "pr":
      case "commit":
      case "crange":
        return value as MentionRef;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** The pill text. Short on purpose: the resolved context carries the full path. */
export function mentionLabel(ref: MentionRef, thread?: { author: string; path: string; line: number | null }): string {
  switch (ref.kind) {
    case "range":
      return `${baseName(ref.path)}:${ref.startLine === ref.endLine ? ref.startLine : `${ref.startLine}-${ref.endLine}`}${ref.side === "old" ? " (base)" : ""}`;
    case "file":
      return baseName(ref.path);
    case "symbol":
      return ref.qualified.replace(/\s+/g, " ");
    case "thread":
      return thread ? `@${thread.author} on ${baseName(thread.path)}${thread.line === null ? "" : `:${thread.line}`}` : "review thread";
    case "pr":
      return "PR description";
    case "commit":
      return `commit ${ref.sha.slice(0, 7)}`;
    case "crange":
      return `${baseName(ref.path)}:${ref.startLine === ref.endLine ? ref.startLine : `${ref.startLine}-${ref.endLine}`}@${ref.sha.slice(0, 7)}`;
  }
}
