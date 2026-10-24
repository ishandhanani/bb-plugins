// Small formatting helpers shared by the review page and the board.

export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function timeAgo(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
