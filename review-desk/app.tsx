// bb-plugin-review-desk — frontend entry.
//
// A PR review page in the shape of a document: state, title, author and
// branches, then Description / Discussion / Commits tabs, then Changes as
// file cards rendered with Pierre diffs (line selection, inline GitHub
// threads, pending comments). The side panel holds Info (checks, reviewers,
// labels, submit review), Chat (bb's own ThreadChat on an analyst thread that
// lives in the PR worktree), and Codemap.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  UrlLink,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
  experimental_FileLink as FileLink,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useAppPanel as useAppPanel,
  experimental_useCodeTheme as useCodeTheme,
  experimental_useFixedTabTarget as useFixedTabTarget,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
  type NewThreadRequest,
  type PluginComposerMention,
} from "@get-bb/plugin-sdk/app";
import { FileDiff, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import type { BriefState, CodemapState, FileEntry, PendingComment, ProviderOption, Review, ReviewSummary, Seat, SelectionRef, rpcContract } from "./server";
import type { Codemap, GhThread } from "./host-contract";
import type { Brief, BriefEvidence, ClaimVerdict } from "./brief-spec";
import type { Evidence as SlopEvidence, SlopReport } from "./slop";
import { MENTION_PROVIDER_ID, encodeMentionRef, mentionLabel, type MentionRef } from "./mention-ref";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;

const PANEL_ID = "reviews";
const PANEL_PATH = "reviews";
const REVIEW_CHANGED = "review-changed";
const PROVIDER_KEY = "review-desk:provider";
const selectionKey = (reviewId: string) => `review-desk:selection:${reviewId}`;

// ---------------------------------------------------------------------------
// Code pills
//
// A pill is a bb @-mention that our server resolves to code when the message
// is sent. The diff page cannot write into a composer directly (it lives in
// the nav panel; the composer lives in the Chat tab), so it queues the pill
// per review and the composer banner, mounted inside the composer, drains the
// queue with `useComposer().insertMention`.
// ---------------------------------------------------------------------------

interface Attach { mention: PluginComposerMention; text?: string }
const ATTACH_EVENT = "review-desk:attach";
const SELECTION_EVENT = "review-desk:selection";
const pendingAttaches = new Map<string, Attach[]>();

function pill(ref: MentionRef): PluginComposerMention {
  return { provider: MENTION_PROVIDER_ID, id: encodeMentionRef(ref), label: mentionLabel(ref) };
}

function selectionPill(reviewId: string, sel: SelectionRef): PluginComposerMention {
  return pill({ kind: "range", reviewId, path: sel.path, startLine: sel.startLine, endLine: sel.endLine, side: sel.side });
}

function queueAttach(reviewId: string, attach: Attach): void {
  pendingAttaches.set(reviewId, [...(pendingAttaches.get(reviewId) ?? []), attach]);
  window.dispatchEvent(new CustomEvent(ATTACH_EVENT, { detail: { reviewId } }));
}

function drainAttaches(reviewId: string): Attach[] {
  const list = pendingAttaches.get(reviewId) ?? [];
  pendingAttaches.delete(reviewId);
  return list;
}

/** Review whose "new chat" composer is on screen; that composer scope has no thread id yet. */
let composingReview: string | null = null;
const composingListeners = new Set<() => void>();
function setComposingReview(reviewId: string | null): void {
  if (composingReview === reviewId) return;
  composingReview = reviewId;
  for (const listener of composingListeners) listener();
}
function useComposingReview(): string | null {
  return useSyncExternalStore(
    (listener) => {
      composingListeners.add(listener);
      return () => composingListeners.delete(listener);
    },
    () => composingReview,
  );
}

const seatLookups = new Map<string, Promise<string | null>>();
function lookupSeatReview(rpc: ReturnType<typeof useRpc<Contract>>, threadId: string): Promise<string | null> {
  let promise = seatLookups.get(threadId);
  if (promise === undefined) {
    promise = rpc.call("seat_lookup", { threadId }).then((r) => r.seat?.reviewId ?? null, () => null);
    seatLookups.set(threadId, promise);
    // Not a seat today may be one later (reset spawns a new thread id, so
    // negative answers are only cached briefly).
    void promise.then((id) => { if (id === null) setTimeout(() => seatLookups.delete(threadId), 5000); });
  }
  return promise;
}

/** The diff selection for a review, shared through storage and kept live by an event. */
function useSelectionRef(reviewId: string | null): SelectionRef | null {
  const read = () => (reviewId === null ? null : readStorage<SelectionRef>(selectionKey(reviewId)));
  const [selection, setSelection] = useState<SelectionRef | null>(read);
  useEffect(() => {
    setSelection(read());
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ reviewId: string }>).detail.reviewId === reviewId) setSelection(read());
    };
    window.addEventListener(SELECTION_EVENT, onChange);
    return () => window.removeEventListener(SELECTION_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);
  return selection;
}

interface ReviewTarget {
  reviewId: string;
  [key: string]: JsonValue;
}
function isReviewTarget(value: JsonValue): value is ReviewTarget {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).reviewId === "string";
}
const INFO_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "info", experimental_target: { validate: isReviewTarget } };
const CHAT_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "chat", experimental_target: { validate: isReviewTarget } };
const CODEMAP_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "codemap", experimental_target: { validate: isReviewTarget } };

const SHIKI_THEMES = new Set([
  "andromeeda", "aurora-x", "ayu-dark", "catppuccin-frappe", "catppuccin-latte", "catppuccin-macchiato", "catppuccin-mocha", "dark-plus", "dracula", "dracula-soft",
  "everforest-dark", "everforest-light", "github-dark", "github-dark-default", "github-dark-dimmed", "github-dark-high-contrast", "github-light", "github-light-default",
  "github-light-high-contrast", "gruvbox-dark-hard", "gruvbox-dark-medium", "gruvbox-dark-soft", "gruvbox-light-hard", "gruvbox-light-medium", "gruvbox-light-soft", "houston",
  "kanagawa-dragon", "kanagawa-lotus", "kanagawa-wave", "laserwave", "light-plus", "material-theme", "material-theme-darker", "material-theme-lighter", "material-theme-ocean",
  "material-theme-palenight", "min-dark", "min-light", "monokai", "night-owl", "nord", "one-dark-pro", "one-light", "plastic", "poimandres", "red", "rose-pine", "rose-pine-dawn",
  "rose-pine-moon", "slack-dark", "slack-ochin", "snazzy-light", "solarized-dark", "solarized-light", "synthwave-84", "tokyo-night", "vesper", "vitesse-black", "vitesse-dark", "vitesse-light",
]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function payloadReview(payload: unknown): { reviewId: string; what: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { reviewId?: unknown; what?: unknown };
  return typeof p.reviewId === "string" ? { reviewId: p.reviewId, what: typeof p.what === "string" ? p.what : "" } : null;
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable; the feature degrades to per-surface defaults
  }
}

function timeAgo(iso: string | number): string {
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

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function fileAnchorId(path: string): string {
  return `rd-file-${path.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
function scrollToFile(path: string): void {
  document.getElementById(fileAnchorId(path))?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { name: path, dir: "" } : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

interface ReviewDetail {
  review: Review;
  files: FileEntry[];
  pending: PendingComment[];
  threads: GhThread[];
  seats: Seat[];
  chatProjectId: string;
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useReviews() {
  const rpc = useRpc<Contract>();
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("reviews_list").then(
      (result) => {
        setReviews(result.reviews);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(REVIEW_CHANGED, refetch);
  return { reviews, error, refetch };
}

function useReview(reviewId: string | null) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (reviewId === null) return;
    rpc.call("reviews_get", { reviewId }).then(
      (result) => {
        setDetail(result);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, reviewId]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    refetch();
  }, [refetch]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p === null || p.reviewId === reviewId) refetch();
  });
  return { rpc, detail, error, refetch };
}

function useCodemap(reviewId: string | null, enabled: boolean) {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<CodemapState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (refresh = false) => {
      if (reviewId === null || !enabled) return;
      rpc.call("codemap_get", { reviewId, refresh }).then(
        (result) => {
          setState(result);
          setError(null);
        },
        (cause: unknown) => setError(describeError(cause)),
      );
    },
    [rpc, reviewId, enabled],
  );
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p !== null && p.reviewId === reviewId && p.what === "codemap") load();
  });
  useEffect(() => {
    if (state?.status !== "building") return;
    const timer = setInterval(() => load(), 4000);
    return () => clearInterval(timer);
  }, [state?.status, load]);
  return { state, error, refresh: () => load(true) };
}

function useBrief(reviewId: string | null) {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<BriefState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (refresh = false) => {
      if (reviewId === null) return;
      rpc.call("brief_get", { reviewId, refresh }).then(
        (result) => {
          setState(result);
          setError(null);
        },
        (cause: unknown) => setError(describeError(cause)),
      );
    },
    [rpc, reviewId],
  );
  useEffect(() => {
    setState(null);
    load();
  }, [load]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p !== null && p.reviewId === reviewId && (p.what === "brief" || p.what === "synced" || p.what === "codemap")) load();
  });
  const busy = state !== null && (state.signalsStatus === "computing" || state.briefStatus === "writing");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => load(), 6000);
    return () => clearInterval(timer);
  }, [busy, load]);
  const rewrite = useCallback(() => {
    if (reviewId === null) return;
    rpc.call("brief_write", { reviewId }).then(setState, (cause: unknown) => toast.error(describeError(cause)));
  }, [rpc, reviewId]);
  return { state, error, refresh: () => load(true), rewrite };
}

function useProviders() {
  const rpc = useRpc<Contract>();
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<string>("");
  useEffect(() => {
    rpc.call("context_providers").then(
      (r) => {
        setProviders(r.providers.filter((p) => p.available));
        setDefaultProvider(r.defaultProvider);
      },
      () => setProviders([]),
    );
  }, [rpc]);
  return { providers, defaultProvider };
}

/** The provider used for "Ask" from the diff and preselected in Chat; shared through storage. */
function useChatProvider(providers: ProviderOption[], fallback: string): [string, (id: string) => void] {
  const [providerId, setProviderId] = useState<string>(() => readStorage<string>(PROVIDER_KEY) ?? "");
  useEffect(() => {
    if (providerId !== "" && providers.some((p) => p.id === providerId)) return;
    const next = providers.find((p) => p.id === fallback)?.id ?? providers[0]?.id ?? "";
    if (next !== "") setProviderId(next);
  }, [providers, fallback, providerId]);
  const set = (id: string) => {
    setProviderId(id);
    writeStorage(PROVIDER_KEY, id);
  };
  return [providerId, set];
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function StatePill({ state, isDraft }: { state: string; isDraft: boolean }) {
  const label = isDraft ? "Draft" : state === "OPEN" ? "Open" : state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : state.toLowerCase();
  const tone = isDraft ? "border-border text-muted-foreground" : state === "OPEN" ? "border-primary/40 bg-primary/10 text-primary" : state === "MERGED" ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-destructive/40 bg-destructive/10 text-destructive";
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", tone)}><Icon name="GitPullRequest" className="size-3" />{label}</span>;
}

function Progress({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-border", className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={total}>
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

function reviewStateTone(state: string): string {
  switch (state) {
    case "APPROVED": return "text-primary";
    case "CHANGES_REQUESTED": return "text-destructive";
    default: return "text-muted-foreground";
  }
}
function reviewStateIcon(state: string): "Check" | "CircleX" | "MessageSquare" | "Clock" {
  switch (state) {
    case "APPROVED": return "Check";
    case "CHANGES_REQUESTED": return "CircleX";
    case "REQUESTED": case "PENDING": return "Clock";
    default: return "MessageSquare";
  }
}

// ---------------------------------------------------------------------------
// Annotations inside the diff
// ---------------------------------------------------------------------------

type Anno =
  | { kind: "thread"; thread: GhThread }
  | { kind: "pending"; pending: PendingComment }
  | { kind: "composer"; path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; initial: string };

interface AnnoActions {
  /** The PR author's login, to color their comments. */
  prAuthor: string | null;
  reply(commentId: number, body: string): Promise<void>;
  resolve(threadId: string, resolve: boolean): Promise<void>;
  savePending(input: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string }): Promise<void>;
  updatePending(id: string, body: string): Promise<void>;
  deletePending(id: string): Promise<void>;
  closeComposer(): void;
}

function TextArea({ value, onChange, rows, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; rows: number; placeholder?: string; autoFocus?: boolean }) {
  return (
    <textarea
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

// Annotations are slotted into Pierre's diff container and inherit its
// monospace font and `white-space: pre`, which is why comment bodies used to
// run off the right edge. These classes reset that and tame Markdown output.
const PROSE = cn(
  "font-sans text-[13px] leading-relaxed whitespace-normal text-foreground [overflow-wrap:anywhere] min-w-0 max-w-full",
  "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:my-2 [&_h1]:text-sm [&_h2]:my-2 [&_h2]:text-sm [&_h3]:my-1.5 [&_h3]:text-[13px] [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_pre]:rounded-md [&_pre]:text-[12px] [&_code]:text-[12px] [&_:not(pre)>code]:whitespace-pre-wrap [&_:not(pre)>code]:[overflow-wrap:anywhere]",
  "[&_table]:my-1.5 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[12px] [&_img]:max-w-full [&_a]:underline [&_a]:decoration-border [&_hr]:my-2",
);

const BOT_LOGINS = new Set(["coderabbitai", "github-actions", "copilot", "copilot-pull-request-reviewer", "dependabot", "codecov", "greptile", "greptile-apps", "cursor", "devin-ai-integration", "sourcery-ai", "ellipsis-dev", "gemini-code-assist", "claude", "codex", "renovate", "sonarcloud", "graphite-app"]);
function isBot(login: string): boolean {
  return /\[bot\]$/i.test(login) || BOT_LOGINS.has(login.toLowerCase().replace(/\[bot\]$/i, ""));
}

const SEVERITIES: { test: RegExp; label: string; className: string }[] = [
  { test: /\b(critical|blocker|p0)\b/i, label: "critical", className: "border-destructive/50 bg-destructive/10 text-destructive" },
  { test: /\b(major|p1|high|important)\b/i, label: "major", className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  { test: /\b(minor|p2|medium|suggestion)\b/i, label: "minor", className: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  { test: /\b(nit|nitpick|p3|low|trivial|style)\b/i, label: "nit", className: "border-border bg-muted text-muted-foreground" },
];
/** Severity and finding id from the first line of a comment, e.g. "**R1-19 · Major — …**". */
function commentTags(body: string): { severity: { label: string; className: string } | null; id: string | null } {
  const head = body.split("\n")[0].slice(0, 160);
  const severity = SEVERITIES.find((s) => s.test.test(head)) ?? null;
  const id = /\b([A-Z]{1,3}\d*-\d{1,3})\b/.exec(head)?.[1] ?? null;
  return { severity: severity ? { label: severity.label, className: severity.className } : null, id };
}

function AuthorChip({ login, prAuthor, when }: { login: string; prAuthor: string | null; when?: string }) {
  const bot = isBot(login);
  const author = prAuthor !== null && login.toLowerCase() === prAuthor.toLowerCase();
  const tone = bot ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" : author ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-foreground/5 text-foreground";
  const name = login.replace(/\[bot\]$/i, "");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-sans text-xs">
      <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold uppercase", tone)}>{name[0] ?? "?"}</span>
      <span className="truncate font-medium text-foreground">{name}</span>
      {bot ? <span className="rounded-full border border-violet-500/40 px-1.5 text-[10px] text-violet-700 dark:text-violet-300">bot</span> : author ? <span className="rounded-full border border-primary/40 px-1.5 text-[10px] text-primary">author</span> : null}
      {when ? <span className="text-muted-foreground">· {timeAgo(when)}</span> : null}
    </span>
  );
}

/** GitHub comment Markdown: HTML comments dropped, `<details>` rendered as real collapsibles. */
function CommentBody({ body, className }: { body: string; className?: string }) {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  const parts: ReactNode[] = [];
  const re = /<details[^>]*>\s*(?:<summary[^>]*>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) parts.push(<Markdown key={`t${i}`} content={cleaned.slice(last, m.index)} />);
    parts.push(
      <details key={`d${i}`} className="my-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">{(m[1] ?? "Details").replace(/<[^>]+>/g, "").trim() || "Details"}</summary>
        <div className="pt-1"><Markdown content={m[2].trim()} /></div>
      </details>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < cleaned.length) parts.push(<Markdown key={`t${i}`} content={cleaned.slice(last)} />);
  return <div className={cn(PROSE, className)}>{parts}</div>;
}

function ThreadCard({ thread, actions }: { thread: GhThread; actions: AnnoActions }) {
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = thread.comments[0];
  const tags = first ? commentTags(first.body) : { severity: null, id: null };
  return (
    <div className={cn("my-1.5 rounded-lg border bg-card font-sans text-xs shadow-sm", thread.isResolved ? "border-border/60 opacity-70" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <Icon name="Github" className="size-3.5 shrink-0 text-muted-foreground" />
        {first ? <AuthorChip login={first.author} prAuthor={actions.prAuthor} /> : <span className="font-medium">thread</span>}
        {thread.comments.length > 1 ? <span className="text-muted-foreground">+{thread.comments.length - 1}</span> : null}
        {tags.id ? <span className="rounded-full border border-border px-1.5 font-mono text-[10px]">{tags.id}</span> : null}
        {tags.severity ? <span className={cn("rounded-full border px-1.5 text-[10px] font-medium", tags.severity.className)}>{tags.severity.label}</span> : null}
        {thread.isResolved ? <span className="inline-flex items-center gap-0.5 rounded-full border border-primary/40 px-1.5 text-[10px] text-primary"><Icon name="Check" className="size-3" />resolved</span> : null}
        {thread.isOutdated ? <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">outdated</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {first?.url ? <UrlLink href={first.url} className="text-muted-foreground hover:text-foreground" title="Open on GitHub"><Icon name="ExternalLink" className="size-3.5" /></UrlLink> : null}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setReply((r) => (r === null ? "" : null))}>Reply</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={async () => { setBusy(true); try { await actions.resolve(thread.id, !thread.isResolved); } finally { setBusy(false); } }}>
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {thread.comments.map((c, index) => (
          <div key={c.id} className="px-3 py-2">
            {index > 0 ? <div className="mb-1"><AuthorChip login={c.author} prAuthor={actions.prAuthor} when={c.createdAt} /></div> : <div className="mb-1 text-muted-foreground">{timeAgo(c.createdAt)}</div>}
            <CommentBody body={c.body} />
          </div>
        ))}
      </div>
      {reply !== null ? (
        <form className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); const target = first?.databaseId; if (!target || reply.trim() === "") return; setBusy(true); try { await actions.reply(target, reply.trim()); setReply(null); } finally { setBusy(false); } }}>
          <TextArea value={reply} onChange={setReply} rows={3} placeholder="Reply on GitHub…" autoFocus />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setReply(null)}>Cancel</Button>
            <Button type="submit" size="sm" className="h-7" disabled={busy || reply.trim() === ""}>Reply</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function PendingCard({ pending, actions }: { pending: PendingComment; actions: AnnoActions }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="my-1.5 rounded-lg border border-dashed border-foreground/40 bg-card font-sans text-xs shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <Icon name="Edit" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Pending comment</span>
        <span className="text-muted-foreground">posts with your review</span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing((e) => (e === null ? pending.body : null))}>Edit</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => void actions.deletePending(pending.id)}>Delete</Button>
        </span>
      </div>
      {editing === null ? (
        <CommentBody body={pending.body} className="px-3 py-2" />
      ) : (
        <form className="flex flex-col gap-1.5 px-3 py-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (editing.trim() === "") return; await actions.updatePending(pending.id, editing.trim()); setEditing(null); }}>
          <TextArea value={editing} onChange={setEditing} rows={4} autoFocus />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" size="sm" className="h-7">Save</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ComposerCard({ anno, actions }: { anno: Extract<Anno, { kind: "composer" }>; actions: AnnoActions }) {
  const [body, setBody] = useState(anno.initial);
  const [busy, setBusy] = useState(false);
  return (
    <form className="my-1.5 flex flex-col gap-1.5 rounded-lg border border-foreground/50 bg-card px-3 py-2 font-sans text-xs shadow-sm" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (body.trim() === "") return; setBusy(true); try { await actions.savePending({ path: anno.path, line: anno.line, startLine: anno.startLine, side: anno.side, body: body.trim() }); actions.closeComposer(); } finally { setBusy(false); } }}>
      <div className="text-muted-foreground">
        Comment on line{anno.startLine !== null && anno.startLine !== anno.line ? `s ${anno.startLine}–${anno.line}` : ` ${anno.line}`} ({anno.side === "LEFT" ? "base" : "head"}). Stays pending until you submit the review.
      </div>
      <TextArea value={body} onChange={setBody} rows={4} placeholder="Write the comment (Markdown)…" autoFocus />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={actions.closeComposer}>Cancel</Button>
        <Button type="submit" size="sm" className="h-7" disabled={busy || body.trim() === ""}>Add pending comment</Button>
      </div>
    </form>
  );
}

function Annotation({ anno, actions }: { anno: Anno; actions: AnnoActions }) {
  // The wrapper undoes the diff container's monospace + pre inheritance for everything inside.
  const card = (() => {
    switch (anno.kind) {
      case "thread": return <ThreadCard thread={anno.thread} actions={actions} />;
      case "pending": return <PendingCard pending={anno.pending} actions={actions} />;
      case "composer": return <ComposerCard anno={anno} actions={actions} />;
    }
  })();
  return <div className="min-w-0 max-w-full whitespace-normal font-sans [tab-size:4]">{card}</div>;
}

// ---------------------------------------------------------------------------
// File card
// ---------------------------------------------------------------------------

interface Selection {
  path: string;
  range: SelectedLineRange;
}

function toSelectionRef(selection: Selection): SelectionRef {
  return {
    path: selection.path,
    startLine: Math.min(selection.range.start, selection.range.end),
    endLine: Math.max(selection.range.start, selection.range.end),
    side: (selection.range.side ?? "additions") === "deletions" ? "old" : "new",
  };
}

interface FileCardProps {
  review: Review;
  file: FileEntry;
  threads: GhThread[];
  pending: PendingComment[];
  composer: Extract<Anno, { kind: "composer" }> | null;
  selection: Selection | null;
  onSelect(selection: Selection | null): void;
  onOpenComposer(path: string, range: SelectedLineRange): void;
  expanded: boolean;
  onToggle(): void;
  onViewed(viewed: boolean): void;
  diffStyle: "unified" | "split";
  theme: { dark: string; light: string; mode: "dark" | "light" };
  actions: AnnoActions;
  rpc: ReturnType<typeof useRpc<Contract>>;
  onAttach(selection: SelectionRef): void;
  onSummarize(): void;
  onCouncil(text: string): void;
}

function FileCard(props: FileCardProps) {
  const { review, file, expanded, onToggle, selection, diffStyle, theme, actions, rpc } = props;
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { name, dir } = splitPath(file.path);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "900px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!expanded || !visible || patch !== null || file.binary) return;
    rpc.call("review_patch", { reviewId: review.id, path: file.path }).then((r) => setPatch(r.patch), (c: unknown) => setError(describeError(c)));
  }, [expanded, visible, patch, file.binary, file.path, review.id, rpc]);

  useEffect(() => {
    setPatch(null);
  }, [review.headSha]);

  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (patch === null || patch.trim() === "") return null;
    try {
      return parsePatchFiles(patch)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [patch]);

  const annotations = useMemo<DiffLineAnnotation<Anno>[]>(() => {
    const list: DiffLineAnnotation<Anno>[] = [];
    for (const thread of props.threads) {
      const line = thread.line ?? thread.originalLine;
      if (line === null) continue;
      list.push({ side: thread.side === "LEFT" ? "deletions" : "additions", lineNumber: line, metadata: { kind: "thread", thread } });
    }
    for (const pending of props.pending) list.push({ side: pending.side === "LEFT" ? "deletions" : "additions", lineNumber: pending.line, metadata: { kind: "pending", pending } });
    if (props.composer) list.push({ side: props.composer.side === "LEFT" ? "deletions" : "additions", lineNumber: props.composer.line, metadata: props.composer });
    return list;
  }, [props.threads, props.pending, props.composer]);

  const selected = selection?.path === file.path ? selection.range : null;
  const loadDiffFiles = useCallback(
    async (meta: FileDiffMetadata) => {
      const [oldSide, newSide] = await Promise.all([
        rpc.call("review_file", { reviewId: review.id, path: file.path, side: "old" }),
        rpc.call("review_file", { reviewId: review.id, path: file.path, side: "new" }),
      ]);
      return {
        oldFile: { name: meta.prevName ?? meta.name, contents: oldSide.content ?? "" },
        newFile: { name: meta.name, contents: newSide.content ?? "" },
      };
    },
    [rpc, review.id, file.path],
  );

  return (
    <div ref={ref} id={fileAnchorId(file.path)} className="scroll-mt-3 rounded-lg border border-border bg-card">
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border bg-card/95 px-3 py-2 text-xs backdrop-blur">
        <button type="button" onClick={onToggle} className="text-muted-foreground hover:text-foreground" aria-expanded={expanded} aria-label={expanded ? "Collapse file" : "Expand file"}>
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{name}</span>
          {dir ? <span className="ml-2 text-muted-foreground">{dir}</span> : null}
          {file.oldPath && file.oldPath !== file.path ? <span className="ml-2 text-muted-foreground">renamed from {file.oldPath}</span> : null}
        </span>
        {file.unresolvedCount > 0 ? <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${file.unresolvedCount} open GitHub thread${file.unresolvedCount === 1 ? "" : "s"}`}><Icon name="Github" className="size-3" />{file.unresolvedCount}</span> : null}
        {file.pendingCount > 0 ? <span className="rounded-full border border-dashed border-foreground/40 px-1.5 text-[10px]">{file.pendingCount} pending</span> : null}
        <span className="font-mono"><span className="text-primary">+{file.additions}</span> <span className="ml-1 text-destructive">-{file.deletions}</span></span>
        <Button variant="ghost" size="sm" className={cn("h-6 px-2 text-xs", file.viewed && "text-primary")} onClick={() => props.onViewed(!file.viewed)}>
          {file.viewed ? <><Icon name="Check" className="size-3" />Viewed</> : "Mark as viewed"}
        </Button>
        <span className="relative">
          <Button variant="ghost" size="sm" className="h-6 w-6 px-0" onClick={() => setMenu((m) => !m)} aria-label="File actions" aria-expanded={menu}><Icon name="MoreHorizontal" className="size-3.5" /></Button>
          {menu ? (
            <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-border bg-card p-1 text-xs shadow-md">
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover" onClick={() => { setMenu(false); props.onSummarize(); }}><Icon name="Brain" className="size-3.5" />Summarize in chat</button>
              <FileLink target={{ kind: "host", hostId: review.hostId, path: `${review.worktree}/${file.path}` }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover" onClick={() => setMenu(false)}><Icon name="ExternalLink" className="size-3.5" />Open file at head</FileLink>
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover" onClick={() => { void navigator.clipboard?.writeText(file.path); setMenu(false); toast.success("Path copied"); }}><Icon name="Copy" className="size-3.5" />Copy path</button>
            </div>
          ) : null}
        </span>
      </div>

      {selected ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">
            L{Math.min(selected.start, selected.end)}{selected.start !== selected.end ? `–${Math.max(selected.start, selected.end)}` : ""}{selected.side === "deletions" ? " (base)" : ""}
          </span>
          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => props.onAttach(toSelectionRef({ path: file.path, range: selected }))} title="Put these lines in the chat as a pill, then ask (shortcut: a)">
            <Icon name="Brain" className="size-3.5" />Add to chat<kbd className="ml-1 rounded border border-primary-foreground/40 px-1 font-mono text-[10px] opacity-80">a</kbd>
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => props.onOpenComposer(file.path, selected)}><Icon name="Edit" className="size-3.5" />Comment</Button>
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => props.onCouncil(`${review.owner}/${review.repo}#${review.number} · ${file.path}:${Math.min(selected.start, selected.end)}-${Math.max(selected.start, selected.end)} (head ${shortSha(review.headSha)})\n\nPlease look at this range.`)} title="Send this range to a Roundtable room"><Icon name="MessageSquare" className="size-3.5" />Council</Button>
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={() => props.onSelect(null)} aria-label="Clear selection"><Icon name="X" className="size-3.5" /></Button>
        </div>
      ) : null}

      {!expanded ? null : file.binary ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">Binary file.</div>
      ) : error ? (
        <div className="px-3 py-3 text-xs text-destructive">{error}</div>
      ) : patch === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">{visible ? "Loading diff…" : `${file.additions + file.deletions} changed lines`}</div>
      ) : fileDiff === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">No textual diff.</div>
      ) : (
        <div className="overflow-x-auto text-[12.5px]">
          <FileDiff<Anno>
            fileDiff={fileDiff}
            options={{
              diffStyle,
              theme: { dark: theme.dark, light: theme.light },
              themeType: theme.mode,
              disableFileHeader: true,
              enableLineSelection: true,
              controlledSelection: true,
              lineHoverHighlight: "both",
              enableGutterUtility: true,
              onLineSelected: (range) => props.onSelect(range === null ? null : { path: file.path, range }),
              onGutterUtilityClick: (range) => props.onOpenComposer(file.path, range),
              loadDiffFiles,
              hunkSeparators: "line-info",
              overflow: "scroll",
            }}
            selectedLines={selected}
            lineAnnotations={annotations}
            renderAnnotation={(annotation) => <Annotation anno={annotation.metadata} actions={actions} />}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room sender (Roundtable bridge)
// ---------------------------------------------------------------------------

function RoomSender({ text, onClose }: { text: string; onClose: () => void }) {
  const rpc = useRpc<Contract>();
  const [rooms, setRooms] = useState<{ id: string; title: string; handles: string[] }[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [roomId, setRoomId] = useState("");
  const [body, setBody] = useState(text);
  const [tags, setTags] = useState<string[]>([]);
  const [turns, setTurns] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    rpc.call("rooms_list").then((r) => { setRooms(r.rooms); setAvailable(r.available); setRoomId(r.rooms[0]?.id ?? ""); }, (c: unknown) => setError(describeError(c)));
  }, [rpc]);
  const room = rooms?.find((r) => r.id === roomId);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/60 p-4" role="dialog" aria-label="Send to the council">
      <form className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-card p-4 text-sm shadow-lg" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (roomId === "" || body.trim() === "") return; setBusy(true); setError(null); try { await rpc.call("send_to_room", { roomId, text: body.trim(), tags, turns }); toast.success("Sent to the room"); onClose(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); } }}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">Send to the council</span>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close"><Icon name="X" className="size-4" /></Button>
        </div>
        {!available ? <p className="text-xs text-destructive">The Roundtable plugin is not running.</p> : null}
        <label className="block space-y-1 text-xs text-muted-foreground">
          Room
          <select value={roomId} onChange={(e) => { setRoomId(e.target.value); setTags([]); }} className="block h-8 w-full rounded-md border border-input bg-background px-2 text-xs">
            {(rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </label>
        {room ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Tag:</span>
            {room.handles.map((h) => (
              <button key={h} type="button" onClick={() => setTags((t) => (t.includes(h) ? t.filter((x) => x !== h) : [...t, h]))} className={cn("rounded-full border border-border px-2 py-0.5", tags.includes(h) && "bg-foreground text-background")}>@{h}</button>
            ))}
            <label className="ml-auto inline-flex items-center gap-1 text-muted-foreground">Turns<Input type="number" min={0} max={40} value={turns} onChange={(e) => setTurns(Math.max(0, Math.min(40, Number(e.target.value) || 0)))} className="h-7 w-14 text-xs" /></label>
          </div>
        ) : null}
        <TextArea value={body} onChange={setBody} rows={8} />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || roomId === "" || body.trim() === ""}><Icon name="Sent" className="size-3.5" />Send</Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review page
// ---------------------------------------------------------------------------

function Description({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 8);
  }, [body]);
  if (body.trim() === "") return <p className="text-sm text-muted-foreground">No description.</p>;
  return (
    <div>
      <div ref={ref} className={cn("relative text-sm", !open && "max-h-72 overflow-hidden")}>
        <Markdown content={body} />
        {!open && overflowing ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" /> : null}
      </div>
      {overflowing || open ? (
        <div className="mt-2 flex justify-center">
          <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : "Read more"}<Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Discussion({ reviewId, threads }: { reviewId: string; threads: GhThread[] }) {
  const rpc = useRpc<Contract>();
  const [conversation, setConversation] = useState<{ comments: { id: number; author: string; body: string; createdAt: string; url: string }[]; reviews: { id: number; author: string; state: string; body: string; submittedAt: string | null; url: string }[] } | null>(null);
  const load = useCallback((refresh = false) => {
    rpc.call("review_conversation", { reviewId, refresh }).then((r) => setConversation({ comments: r.comments, reviews: r.reviews }), () => undefined);
  }, [rpc, reviewId]);
  useEffect(() => { load(); }, [load]);
  const open = threads.filter((t) => !t.isResolved);
  if (conversation === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const items = [
    ...conversation.reviews.map((r) => ({ key: `r-${r.id}`, author: r.author, when: r.submittedAt, body: r.body, badge: r.state, url: r.url })),
    ...conversation.comments.map((c) => ({ key: `c-${c.id}`, author: c.author, when: c.createdAt, body: c.body, badge: null as string | null, url: c.url })),
  ].sort((a, b) => Date.parse(a.when ?? "") - Date.parse(b.when ?? ""));
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{items.length} comments and reviews · {open.length} open threads in the diff</span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => { load(true); void rpc.call("review_threads_refresh", { reviewId }); }} aria-label="Refresh discussion"><Icon name="ArrowReloadHorizontal" className="size-3.5" /></Button>
      </div>
      {open.length > 0 ? (
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-1.5 text-xs font-medium">Open threads</div>
          <ul className="divide-y divide-border/60">
            {open.slice(0, 40).map((t) => (
              <li key={t.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                <button type="button" onClick={() => scrollToFile(t.path)} className="shrink-0 font-mono hover:underline">{splitPath(t.path).name}{t.line ? `:${t.line}` : ""}</button>
                <span className="min-w-0 truncate text-muted-foreground"><span className="font-medium text-foreground">{t.comments[0]?.author}</span> {t.comments[0]?.body.split("\n")[0]}</span>
              </li>
            ))}
            {open.length > 40 ? <li className="px-3 py-1.5 text-xs text-muted-foreground">and {open.length - 40} more in the diff</li> : null}
          </ul>
        </div>
      ) : null}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key} className="rounded-lg border border-border bg-card p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{item.author}</span>
              {item.badge ? <span className={cn("inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0 text-[10px] uppercase", reviewStateTone(item.badge))}>{item.badge.replace(/_/g, " ").toLowerCase()}</span> : null}
              {item.when ? <span>{timeAgo(item.when)}</span> : null}
              <UrlLink href={item.url} className="ml-auto hover:text-foreground" title="Open on GitHub"><Icon name="ExternalLink" className="size-3.5" /></UrlLink>
            </div>
            {item.body.trim() === "" ? <span className="text-xs text-muted-foreground">No text.</span> : <Markdown content={item.body} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Commits({ review }: { review: Review }) {
  if (review.commits.length === 0) return <p className="text-sm text-muted-foreground">No commits.</p>;
  return (
    <ul className="divide-y divide-border/60 rounded-lg border border-border text-sm">
      {[...review.commits].reverse().map((c) => (
        <li key={c.sha} className="flex items-center gap-3 px-3 py-2">
          <UrlLink href={`${review.url.replace(/\/pull\/\d+$/, "")}/commit/${c.sha}`} className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground">{shortSha(c.sha)}</UrlLink>
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{c.author} · {timeAgo(c.date)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Brief: slop meter from deterministic signals, plus the helper's plain-English
// summary, areas, claims checked against the diff, and its own AI read.
// ---------------------------------------------------------------------------

type JumpFn = (path: string, line: number | null, side: "old" | "new") => void;

function scoreTone(score: number): string {
  return score < 20 ? "text-primary" : score < 45 ? "text-amber-600 dark:text-amber-400" : score < 70 ? "text-orange-600 dark:text-orange-400" : "text-destructive";
}

const VERDICT_STYLE: Record<ClaimVerdict, { label: string; className: string }> = {
  matches: { label: "matches", className: "border-primary/40 bg-primary/10 text-primary" },
  partly: { label: "partly", className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  "no-evidence": { label: "no evidence", className: "border-border bg-muted text-muted-foreground" },
  contradicted: { label: "contradicted", className: "border-destructive/50 bg-destructive/10 text-destructive" },
};

function EvidenceLink({ path, line, side, note, onJump }: { path: string; line: number | null; side: "old" | "new"; note?: string; onJump: JumpFn }) {
  if (path === "") return <span className="text-muted-foreground">{note}</span>;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <button type="button" onClick={() => onJump(path, line, side)} className="shrink-0 font-mono text-[11px] text-foreground hover:underline" title={path}>
        {splitPath(path).name}{line !== null ? `:${line}` : ""}
      </button>
      {note ? <span className="min-w-0 text-muted-foreground">{note}</span> : null}
    </span>
  );
}

function SlopMeter({ report, aiScore, onJump, onRecompute, computing }: { report: SlopReport | null; aiScore: number | null; onJump: JumpFn; onRecompute: () => void; computing: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const det = report?.score ?? null;
  const combined = det === null ? aiScore : aiScore === null ? det : Math.round(0.6 * det + 0.4 * aiScore);
  const verdict = combined === null ? "" : combined < 20 ? "Reads hand-made" : combined < 45 ? "Some polish needed" : combined < 70 ? "Heavy AI residue" : "Reads like unedited generation";
  const maxScore = Math.max(1, ...(report?.signals.map((s) => s.score) ?? [1]));
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Slop meter</span>
        <span className="text-xs text-muted-foreground">a heuristic, every number opens its evidence</span>
        {report?.aiAttributed ? <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] text-violet-700 dark:text-violet-300">description credits an AI</span> : null}
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={onRecompute} disabled={computing} title="Recompute the signals from the diff">
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", computing && "animate-spin")} />
        </Button>
      </div>
      {report === null ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" />Reading every changed line…</p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4">
            <div className={cn("text-4xl font-semibold tabular-nums leading-none", scoreTone(combined ?? 0))}>{combined}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{verdict}</div>
              <div className="relative mt-1.5 h-2 rounded-full bg-gradient-to-r from-primary/40 via-amber-400/60 to-destructive/70">
                <div className="absolute -top-0.5 size-3 -translate-x-1/2 rounded-full border-2 border-background bg-foreground shadow" style={{ left: `${combined ?? 0}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>hand-made</span><span>unedited generation</span></div>
              <div className="mt-1 text-xs text-muted-foreground">
                signals {det}{aiScore !== null ? ` · helper's read ${aiScore} · shown 60/40` : " · helper's read pending"} · {report.stats.addedLines.toLocaleString()} added lines in {report.stats.codeFiles} code files
              </div>
            </div>
          </div>
          {report.signals.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">No signals fired.</p> : (
            <ul className="mt-3 divide-y divide-border/60 rounded-md border border-border/60">
              {report.signals.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setOpen((o) => (o === s.id ? null : s.id))} className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-state-hover" aria-expanded={open === s.id}>
                    <Icon name={open === s.id ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="w-44 shrink-0 font-medium">{s.label}</span>
                    <span className="w-10 shrink-0 rounded-full bg-foreground/10 px-1.5 text-center tabular-nums">{s.count}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.description}</span>
                    <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-border"><span className="block h-full rounded-full bg-amber-500/80" style={{ width: `${Math.round((100 * s.score) / maxScore)}%` }} /></span>
                  </button>
                  {open === s.id ? (
                    <ul className="space-y-1 border-t border-border/60 bg-background/60 px-3 py-2 text-xs">
                      {s.evidence.map((e: SlopEvidence, i) => (
                        <li key={i} className="flex gap-2"><span className="w-3 shrink-0 text-muted-foreground">·</span><EvidenceLink path={e.path} line={e.line} side={e.side} note={e.note} onJump={onJump} /></li>
                      ))}
                      {s.count > s.evidence.length ? <li className="text-muted-foreground">and {s.count - s.evidence.length} more</li> : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function BriefPanel({ reviewId, onJump }: { reviewId: string; onJump: JumpFn }) {
  const { state, error, refresh, rewrite } = useBrief(reviewId);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  const report = (state?.signalsStatus === "ready" ? (state.signals as unknown as SlopReport | null) : null) ?? null;
  const brief = (state?.briefStatus === "ready" ? (state.brief as unknown as Brief | null) : null) ?? null;
  const writing = state?.briefStatus === "writing";
  const evidenceList = (list: BriefEvidence[]) => (
    <span className="inline-flex flex-wrap gap-x-2">
      {list.map((e, i) => (e.found ? <EvidenceLink key={i} path={e.path} line={e.line} side="new" onJump={onJump} /> : <span key={i} className="font-mono text-[11px] text-muted-foreground line-through" title="not in this diff">{splitPath(e.path).name}{e.line !== null ? `:${e.line}` : ""}</span>))}
    </span>
  );
  return (
    <div className="space-y-4 text-sm">
      <SlopMeter report={report} aiScore={brief?.ai.score ?? null} onJump={onJump} onRecompute={refresh} computing={state?.signalsStatus === "computing"} />
      {state?.signalsStatus === "failed" ? <p className="text-xs text-destructive">Signals failed: {state.signalsError}</p> : null}

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">What it does</span>
          <span className="text-xs text-muted-foreground">written from the diff, not the description</span>
          {state?.stale ? <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title="The head moved since this was written">stale</span> : null}
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={rewrite} disabled={writing} title="Write the brief again at the current head">
            <Icon name={writing ? "Loading" : "ArrowReloadHorizontal"} className={cn("size-3.5", writing && "animate-spin")} />{brief ? "Rewrite" : "Write"}
          </Button>
        </div>
        {brief === null ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {writing ? "The helper is reading the diff and writing. A minute for small PRs, several for large ones." : state?.briefStatus === "failed" ? `Failed: ${state.briefError ?? "unknown error"}` : state === null ? "Loading…" : "Press Write to get a plain-English brief of this PR."}
          </p>
        ) : (
          <>
            <div className={cn(PROSE, "mt-3 text-sm")}><Markdown content={brief.summary} /></div>
            {brief.areas.length > 0 ? (
              <ul className="mt-4 divide-y divide-border/60 rounded-md border border-border/60 text-xs">
                {brief.areas.map((a) => (
                  <li key={a.module} className="flex items-baseline gap-3 px-3 py-1.5">
                    {a.path ? <button type="button" onClick={() => onJump(a.path ?? "", null, "new")} className="w-48 shrink-0 truncate text-left font-mono hover:underline" title={a.path}>{a.module}</button> : <span className="w-48 shrink-0 truncate font-mono">{a.module}</span>}
                    <span className="min-w-0 text-foreground">{a.what}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      {brief !== null && brief.claims.length > 0 ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Claims versus diff</span>
            <span className="text-xs text-muted-foreground">
              {brief.claims.filter((c) => c.verdict === "matches").length} of {brief.claims.length} hold up
            </span>
          </div>
          <ul className="mt-3 space-y-2 text-xs">
            {brief.claims.map((c, i) => (
              <li key={i} className="flex gap-3 rounded-md border border-border/60 px-3 py-2">
                <span className={cn("mt-0.5 h-fit shrink-0 rounded-full border px-1.5 text-[10px] font-medium", VERDICT_STYLE[c.verdict].className)}>{VERDICT_STYLE[c.verdict].label}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">{c.claim}</span>
                  {c.note ? <span className="block text-muted-foreground">{c.note}</span> : null}
                  {c.evidence.length > 0 ? <span className="mt-0.5 block">{evidenceList(c.evidence)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {brief !== null && brief.ai.reasons.length > 0 ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">The helper's read</span>
            <span className={cn("text-sm font-semibold tabular-nums", scoreTone(brief.ai.score))}>{brief.ai.score}</span>
            <span className="text-xs text-muted-foreground">how much this reads like unedited AI output, from the code itself</span>
          </div>
          <ul className="mt-3 space-y-1.5 text-xs">
            {brief.ai.reasons.map((r, i) => (
              <li key={i} className="flex gap-2"><span className="w-3 shrink-0 text-muted-foreground">·</span><span className="min-w-0"><span className="text-foreground">{r.reason}</span>{r.evidence.length > 0 ? <span className="ml-2">{evidenceList(r.evidence)}</span> : null}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type Tab = "brief" | "description" | "discussion" | "commits";

function ReviewView({ reviewId }: { reviewId: string }) {
  const { rpc, detail, error, refetch } = useReview(reviewId);
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const codeTheme = useCodeTheme();
  const [tab, setTab] = useState<Tab>("brief");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [composer, setComposer] = useState<Extract<Anno, { kind: "composer" }> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedOverride, setExpandedOverride] = useState<Set<string>>(new Set());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [roomText, setRoomText] = useState<string | null>(null);

  const setSelection = useCallback((next: Selection | null) => {
    setSelectionState(next);
    writeStorage(selectionKey(reviewId), next === null ? null : toSelectionRef(next));
    window.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail: { reviewId } }));
  }, [reviewId]);

  const theme = useMemo(() => {
    const known = SHIKI_THEMES.has(codeTheme.name);
    return {
      dark: known && codeTheme.mode === "dark" ? codeTheme.name : "github-dark",
      light: known && codeTheme.mode === "light" ? codeTheme.name : "github-light",
      mode: codeTheme.mode,
    };
  }, [codeTheme.name, codeTheme.mode]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const prAuthor = detail?.review.author ?? null;
  const actions = useMemo<AnnoActions>(() => ({
    prAuthor,
    reply: async (commentId, body) => { await rpc.call("thread_reply", { reviewId, commentId, body }); refetch(); toast.success("Reply posted"); },
    resolve: async (threadId, resolve) => { await rpc.call("thread_resolve", { reviewId, threadId, resolve }); refetch(); },
    savePending: async (input) => { await rpc.call("pending_add", { reviewId, ...input }); refetch(); },
    updatePending: async (id, body) => { await rpc.call("pending_update", { id, body }); refetch(); },
    deletePending: async (id) => { await rpc.call("pending_delete", { id }); refetch(); },
    closeComposer: () => setComposer(null),
  }), [rpc, reviewId, refetch, prAuthor]);

  const openChat = () => panel.openFixedTab({ surface: { kind: "current" }, tab: CHAT_TAB, target: { reviewId } });

  /** Put a pill (and optional text) in the chat composer, opening the Chat tab so its composer is on screen to receive it. */
  const attachToChat = useCallback((mention: PluginComposerMention, text?: string) => {
    queueAttach(reviewId, text === undefined ? { mention } : { mention, text });
    openChat();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  /** Show a place in the diff: expand the file, select the line, and settle the scroll onto it. */
  const jumpToLine = useCallback<JumpFn>((path, line, side) => {
    setFilter("");
    setCollapsed((s) => { const n = new Set(s); n.delete(path); return n; });
    setExpandedOverride((s) => new Set(s).add(path));
    if (line !== null) setSelection({ path, range: { start: line, end: line, side: side === "old" ? "deletions" : "additions" } });
    const wanted = line === null ? null : String(line);
    let tries = 0;
    const settle = () => {
      const card = document.getElementById(fileAnchorId(path));
      const host = card ? Array.from(card.querySelectorAll("*")).find((el) => el.shadowRoot !== null) : undefined;
      const cell = wanted !== null && host?.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll("[data-line-number-content]")).find((el) => el.textContent?.trim() === wanted) : undefined;
      if (cell) {
        cell.scrollIntoView({ block: "center" });
        return;
      }
      card?.scrollIntoView({ block: "start" });
      if (++tries < 10) setTimeout(settle, tries < 4 ? 300 : 600);
    };
    settle();
  }, [setSelection]);

  // `a` with lines selected drops them into the chat; ignored while typing.
  useEffect(() => {
    if (selection === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "a" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      e.preventDefault();
      attachToChat(selectionPill(reviewId, toSelectionRef(selection)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, reviewId, attachToChat]);

  if (error !== null) return <div className="p-6"><p role="alert" className="text-sm text-destructive">{error}</p></div>;
  if (detail === null) return <div className="p-6"><EmptyState>Loading review…</EmptyState></div>;

  const { review, files, threads, pending } = detail;
  const threadsByPath = new Map<string, GhThread[]>();
  for (const t of threads) threadsByPath.set(t.path, [...(threadsByPath.get(t.path) ?? []), t]);
  const pendingByPath = new Map<string, PendingComment[]>();
  for (const p of pending) pendingByPath.set(p.path, [...(pendingByPath.get(p.path) ?? []), p]);
  const viewedCount = files.filter((f) => f.viewed).length;
  const linesLeft = files.filter((f) => !f.viewed).reduce((n, f) => n + f.additions + f.deletions, 0);
  const isExpanded = (f: FileEntry, index: number) => {
    if (collapsed.has(f.path)) return false;
    if (expandedOverride.has(f.path)) return true;
    if (allCollapsed) return false;
    return !f.viewed && index < 60 && f.additions + f.deletions <= 800;
  };
  const toggle = (path: string, expanded: boolean) => {
    if (expanded) {
      setCollapsed((s) => new Set(s).add(path));
      setExpandedOverride((s) => { const n = new Set(s); n.delete(path); return n; });
    } else {
      setCollapsed((s) => { const n = new Set(s); n.delete(path); return n; });
      setExpandedOverride((s) => new Set(s).add(path));
    }
  };
  const shown = filter.trim() === "" ? files : files.filter((f) => f.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const openThreads = threads.filter((t) => !t.isResolved).length;
  const repoUrl = review.url.replace(/\/pull\/\d+$/, "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => navigate.toPluginPanel(PANEL_PATH)} aria-label="Back to reviews"><Icon name="ChevronLeft" className="size-4" /></Button>
        <Icon name="GitPullRequest" className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 truncate"><span className="text-muted-foreground">#{review.number}</span> <span className="font-medium">{review.title}</span> <span className="text-muted-foreground">{review.repo}</span></span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void run("sync", async () => { await rpc.call("reviews_sync", { reviewId }); refetch(); toast.success("Synced with GitHub"); })} disabled={busy !== null} title="Refresh PR metadata, head, and threads">
            <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", busy === "sync" && "animate-spin")} />Sync
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: CODEMAP_TAB, target: { reviewId } })}><Icon name="Layers" className="size-3.5" />Codemap</Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openChat}><Icon name="Brain" className="size-3.5" />Chat</Button>
          <Button size="sm" className="h-7 text-xs" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: INFO_TAB, target: { reviewId } })}>
            <Icon name="Github" className="size-3.5" />Review{pending.length > 0 ? ` · ${pending.length}` : ""}
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-8">
          <div className="space-y-3">
            <StatePill state={review.state} isDraft={review.isDraft} />
            <div className="text-xs text-muted-foreground"><UrlLink href={repoUrl} className="hover:underline">{review.owner}/{review.repo}</UrlLink> #{review.number}</div>
            <h1 className="text-2xl font-semibold leading-tight tracking-tight">
              <UrlLink href={review.url} className="hover:underline">{review.title}</UrlLink>
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {review.author ? <span className="inline-flex items-center gap-1.5"><span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium uppercase">{review.author[0]}</span>{review.author}</span> : null}
              <span className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono">{review.baseRefName}</span>
              <Icon name="ChevronLeft" className="size-3 text-muted-foreground" />
              <span className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono">{review.headRefName}</span>
              <span className="font-mono text-muted-foreground">{shortSha(review.headSha)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Opened {timeAgo(review.createdAt)} · {files.length} files · <span className="text-primary">+{review.additions}</span> <span className="text-destructive">-{review.deletions}</span> · {review.commits.length} commits · synced {timeAgo(review.syncedAt)}
            </div>
          </div>

          <div className="mt-6 flex items-center gap-1 border-b border-border text-sm">
            {([["brief", "Brief", null], ["description", "Description", null], ["discussion", "Discussion", openThreads], ["commits", "Commits", review.commits.length]] as const).map(([id, label, count]) => (
              <button key={id} type="button" onClick={() => setTab(id)} className={cn("-mb-px border-b-2 px-3 py-2", tab === id ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
                {label}{count !== null && count > 0 ? <span className="ml-1.5 rounded-full bg-foreground/10 px-1.5 text-[11px]">{count}</span> : null}
              </button>
            ))}
          </div>
          <div className="mt-4">
            {tab === "brief" ? <BriefPanel reviewId={reviewId} onJump={jumpToLine} /> : tab === "description" ? <Description body={review.body} /> : tab === "discussion" ? <Discussion reviewId={reviewId} threads={threads} /> : <Commits review={review} />}
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Changes</h2>
            <span className="text-xs text-muted-foreground">{viewedCount}/{files.length} viewed</span>
            <Progress value={viewedCount} total={files.length} className="w-24" />
            <span className="text-xs text-muted-foreground">{linesLeft.toLocaleString()} lines left</span>
            <span className="ml-auto flex items-center gap-1.5">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a file…" className="h-7 w-44 text-xs" aria-label="Filter files" />
              <select value={diffStyle} onChange={(e) => setDiffStyle(e.target.value as "unified" | "split")} className="h-7 rounded-md border border-input bg-background px-1.5 text-xs" aria-label="Diff style">
                <option value="unified">Unified</option>
                <option value="split">Split</option>
              </select>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setAllCollapsed((v) => !v); setCollapsed(new Set()); setExpandedOverride(new Set()); }}>{allCollapsed ? "Expand all" : "Collapse all"}</Button>
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-3">
            {shown.length === 0 ? <EmptyState>No files match.</EmptyState> : null}
            {shown.map((f) => {
              const index = files.indexOf(f);
              const expanded = isExpanded(f, index);
              return (
                <FileCard
                  key={f.path}
                  review={review}
                  file={f}
                  threads={threadsByPath.get(f.path) ?? []}
                  pending={pendingByPath.get(f.path) ?? []}
                  composer={composer?.path === f.path ? composer : null}
                  selection={selection}
                  onSelect={setSelection}
                  onOpenComposer={(path, range) => {
                    const start = Math.min(range.start, range.end);
                    const end = Math.max(range.start, range.end);
                    setComposer({ kind: "composer", path, line: end, startLine: start !== end ? start : null, side: (range.side ?? "additions") === "deletions" ? "LEFT" : "RIGHT", initial: "" });
                  }}
                  expanded={expanded}
                  onToggle={() => toggle(f.path, expanded)}
                  onViewed={(viewed) => void run("viewed", async () => { await rpc.call("viewed_set", { reviewId, path: f.path, viewed }); refetch(); })}
                  diffStyle={diffStyle}
                  theme={theme}
                  actions={actions}
                  rpc={rpc}
                  onAttach={(sel) => attachToChat(selectionPill(reviewId, sel))}
                  onSummarize={() => attachToChat(pill({ kind: "file", reviewId, path: f.path }), "Summarize these changes and why they matter for this PR.")}
                  onCouncil={(text) => setRoomText(text)}
                />
              );
            })}
          </div>
        </div>
      </div>
      {roomText !== null ? <RoomSender text={roomText} onClose={() => setRoomText(null)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panel tabs
// ---------------------------------------------------------------------------

function InfoTab() {
  const target = useFixedTabTarget(INFO_TAB);
  const reviewId = target?.target.reviewId ?? null;
  const { rpc, detail, refetch } = useReview(reviewId);
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAllChecks, setShowAllChecks] = useState(false);
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review to see its checks, reviewers, and your pending comments here.</EmptyState></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading…</EmptyState></div>;
  const { review, pending } = detail;
  const ok = (c: Review["checks"][number]) => (c.conclusion ?? "").toLowerCase() === "success" || (c.conclusion ?? "").toLowerCase() === "skipped" || (c.conclusion ?? "").toLowerCase() === "neutral";
  const failing = (c: Review["checks"][number]) => ["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"].includes((c.conclusion ?? "").toLowerCase());
  const passed = review.checks.filter(ok).length;
  const sortedChecks = [...review.checks].sort((a, b) => Number(failing(b)) - Number(failing(a)) || Number(ok(a)) - Number(ok(b)));
  const visibleChecks = showAllChecks ? sortedChecks : sortedChecks.slice(0, 6);
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Review</span>
            <span className="text-muted-foreground">{pending.length} pending comment{pending.length === 1 ? "" : "s"}</span>
          </div>
          {pending.length > 0 ? (
            <ul className="space-y-1">
              {pending.map((p) => (
                <li key={p.id} className="rounded-md border border-dashed border-foreground/40 px-2 py-1">
                  <button type="button" onClick={() => scrollToFile(p.path)} className="font-mono hover:underline">{splitPath(p.path).name}:{p.startLine && p.startLine !== p.line ? `${p.startLine}-` : ""}{p.line}</button>
                  <div className="truncate text-muted-foreground">{p.body.split("\n")[0]}</div>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground">Select lines in the diff and press Comment to add one.</p>}
          <form className="space-y-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { const r = await rpc.call("review_submit", { reviewId, event, body }); toast.success(`Submitted ${r.posted} comment${r.posted === 1 ? "" : "s"} to GitHub`); setBody(""); refetch(); } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); } }}>
            <div className="flex flex-wrap gap-3">
              {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((ev) => (
                <label key={ev} className="inline-flex items-center gap-1.5"><input type="radio" name="event" checked={event === ev} onChange={() => setEvent(ev)} />{ev === "COMMENT" ? "Comment" : ev === "APPROVE" ? "Approve" : "Request changes"}</label>
              ))}
            </div>
            <TextArea value={body} onChange={setBody} rows={3} placeholder="Review summary (optional for comment reviews)" />
            <Button type="submit" size="sm" disabled={busy || (pending.length === 0 && body.trim() === "")}><Icon name="Github" className="size-3.5" />Submit review to GitHub</Button>
          </form>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Checks</span>
            <span className="text-muted-foreground">{passed}/{review.checks.length}</span>
          </div>
          <Progress value={passed} total={review.checks.length} />
          <ul className="space-y-0.5">
            {visibleChecks.map((c, i) => (
              <li key={`${c.name}-${i}`} className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", ok(c) ? "bg-primary" : failing(c) ? "bg-destructive" : "bg-muted-foreground/40")} />
                {c.url ? <UrlLink href={c.url} className="min-w-0 truncate hover:underline">{c.name}</UrlLink> : <span className="min-w-0 truncate">{c.name}</span>}
                <span className="ml-auto shrink-0 text-muted-foreground">{(c.conclusion ?? c.status).toLowerCase().replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
          {review.checks.length > 6 ? <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setShowAllChecks((v) => !v)}>{showAllChecks ? "Show fewer" : `Show all ${review.checks.length}`}</Button> : null}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Reviewers</span><span className="text-muted-foreground">{review.reviewers.length}</span></div>
          {review.reviewers.length === 0 ? <p className="text-muted-foreground">None yet.</p> : (
            <ul className="space-y-1">
              {review.reviewers.map((r) => (
                <li key={r.login} className="flex items-center gap-2">
                  <span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium uppercase">{r.login[0]}</span>
                  <span className="min-w-0 truncate">{r.login}</span>
                  <Icon name={reviewStateIcon(r.state)} className={cn("ml-auto size-3.5", reviewStateTone(r.state))} aria-label={r.state} />
                </li>
              ))}
            </ul>
          )}
          {review.reviewDecision ? <p className="text-muted-foreground">Decision: {review.reviewDecision.replace(/_/g, " ").toLowerCase()}</p> : null}
        </section>

        <section className="space-y-2">
          <span className="text-sm font-semibold">Assignees</span>
          <p className="text-muted-foreground">{review.assignees.length === 0 ? "No assignees" : review.assignees.join(", ")}</p>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Labels</span><span className="text-muted-foreground">{review.labels.length}</span></div>
          <div className="flex flex-wrap gap-1">{review.labels.map((l) => <span key={l} className="rounded-full border border-border px-2 py-0.5">{l}</span>)}</div>
        </section>
      </div>
    </div>
  );
}

function ChatTab() {
  const target = useFixedTabTarget(CHAT_TAB);
  const reviewId = target?.target.reviewId ?? null;
  const { rpc, detail, refetch } = useReview(reviewId);
  const { providers, defaultProvider } = useProviders();
  const [providerId, setProviderId] = useChatProvider(providers, defaultProvider);
  const [composing, setComposing] = useState(false);
  const [roomText, setRoomText] = useState<string | null>(null);
  const seats = detail?.seats ?? [];
  const seat = composing ? null : seats.find((s) => s.providerId === providerId) ?? seats[0] ?? null;

  // The "new chat" composer has no thread yet; tell the composer banner which
  // review it belongs to so queued pills land in it.
  useEffect(() => {
    if (reviewId === null || detail === null || seat !== null) return;
    setComposingReview(reviewId);
    return () => setComposingReview(null);
  }, [reviewId, detail, seat]);

  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and press Chat to talk with its analyst here.</EmptyState></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading…</EmptyState></div>;
  const { review } = detail;
  const displayName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;

  const start = async (request: NewThreadRequest) => {
    await rpc.call("chat_start", {
      reviewId,
      providerId: request.providerId,
      model: request.model,
      reasoningLevel: request.reasoningLevel,
      permissionMode: request.permissionMode,
      ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
      executionInputSources: request.executionInputSources as Record<string, "client-preference" | "explicit">,
      input: request.input as unknown as Record<string, unknown>[],
    });
    setProviderId(request.providerId);
    setComposing(false);
    refetch();
  };
  const addAsComment = async (text: string) => {
    const sel = readStorage<SelectionRef>(selectionKey(reviewId));
    if (sel === null) {
      toast.error("Select lines in the diff first, then use this action to attach the answer there.");
      return;
    }
    try {
      await rpc.call("pending_add", { reviewId, path: sel.path, line: sel.endLine, startLine: sel.startLine !== sel.endLine ? sel.startLine : null, side: sel.side === "old" ? "LEFT" : "RIGHT", body: text.trim() });
      toast.success(`Pending comment added at ${splitPath(sel.path).name}:${sel.endLine}`);
      refetch();
    } catch (cause) {
      toast.error(describeError(cause));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        {seats.map((s) => (
          <button key={s.providerId} type="button" onClick={() => { setProviderId(s.providerId); setComposing(false); }} className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1", seat?.providerId === s.providerId ? "bg-state-active font-medium" : "text-muted-foreground hover:bg-state-hover")}>
            {displayName(s.providerId)}
          </button>
        ))}
        <button type="button" onClick={() => setComposing(true)} className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1", seat === null ? "bg-state-active font-medium" : "text-muted-foreground hover:bg-state-hover")} title="Start a chat with another provider">
          <Icon name="Plus" className="size-3.5" />{seats.length === 0 ? "New chat" : null}
        </button>
        {seat ? (
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={() => { if (window.confirm("Reset this chat? The analyst starts over with a fresh thread.")) void rpc.call("chat_reset", { reviewId, providerId: seat.providerId }).then(() => refetch()); }} title="Start a fresh analyst thread">
            <Icon name="RotateCcw" className="size-3.5" />Reset
          </Button>
        ) : null}
      </div>
      {seat ? (
        <ThreadChat
          key={seat.threadId}
          threadId={seat.threadId}
          variant="compact"
          layout="contained"
          className="min-h-0 flex-1"
          messageActions={[
            { id: "add-comment", title: "Add as PR comment on the selected lines", icon: "Edit", roles: ["assistant"], run: (message) => { void addAsComment(message.text); } },
            { id: "council", title: "Send to the council", icon: "MessageSquare", roles: ["assistant", "user"], run: (message) => setRoomText(message.text) },
          ]}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4 text-sm">
            <p className="font-medium">Chat with this PR</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The analyst runs in a worktree at the PR head with the full diff, description, and repository at hand. It reads, it never edits.
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              <li><kbd className="rounded border border-border px-1 font-mono">@</kbd> attaches a changed file, symbol, review thread, or <span className="font-mono">path:10-20</span> as a pill.</li>
              <li>Select lines in the diff and press <kbd className="rounded border border-border px-1 font-mono">a</kbd> or <span className="text-foreground">Add to chat</span>.</li>
              <li>Pills turn into code when you send. You keep a short transcript; the analyst gets the excerpt.</li>
            </ul>
          </div>
          <div className="border-t border-border p-2">
            <NewThreadComposer
              defaultProjectId={detail.chatProjectId}
              defaultProviderId={providerId || defaultProvider || undefined}
              defaultEnvironment={review.environmentId ? { type: "reuse", environmentId: review.environmentId } : { type: "host", hostId: review.hostId, workspace: { type: "unmanaged", path: review.worktree } }}
              placeholder="Ask about the PR. @ attaches code, a adds the selected lines."
              layout="contained"
              draftKey={`review-desk:${reviewId}`}
              onSubmit={start}
            />
          </div>
        </div>
      )}
      {roomText !== null ? <RoomSender text={roomText} onClose={() => setRoomText(null)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer banner: lives inside every thread and new-thread composer, shows
// only for our analyst composers. Drains queued pills and offers the current
// diff selection.
// ---------------------------------------------------------------------------

function PillBanner() {
  const view = useComposerView();
  const composer = useComposer();
  const rpc = useRpc<Contract>();
  const scope = view.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const composing = useComposingReview();
  const [seatReview, setSeatReview] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === null) {
      setSeatReview(null);
      return;
    }
    let cancelled = false;
    void lookupSeatReview(rpc, threadId).then((id) => { if (!cancelled) setSeatReview(id); });
    return () => { cancelled = true; };
  }, [threadId, rpc]);
  const reviewId = scope.kind === "thread" ? seatReview : scope.kind === "new-thread" ? composing : null;
  const selection = useSelectionRef(reviewId);

  const composerRef = useRef(composer);
  composerRef.current = composer;
  useEffect(() => {
    if (reviewId === null) return;
    const drain = () => {
      const list = drainAttaches(reviewId);
      if (list.length === 0) return;
      for (const attach of list) {
        composerRef.current.insertMention(attach.mention);
        if (attach.text) composerRef.current.updateText((t) => `${t.trim() === "" ? "" : `${t.trimEnd()} `}${attach.text}`);
      }
      composerRef.current.focus();
    };
    drain();
    const onAttach = (e: Event) => { if ((e as CustomEvent<{ reviewId: string }>).detail.reviewId === reviewId) drain(); };
    window.addEventListener(ATTACH_EVENT, onAttach);
    return () => window.removeEventListener(ATTACH_EVENT, onAttach);
  }, [reviewId]);

  if (reviewId === null || selection === null) return null;
  const label = mentionLabel({ kind: "range", reviewId, path: selection.path, startLine: selection.startLine, endLine: selection.endLine, side: selection.side });
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
      <Icon name="Code" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">Selected <span className="font-mono text-foreground">{label}</span>{splitPath(selection.path).dir ? <span> in {splitPath(selection.path).dir}</span> : null}</span>
      <button type="button" className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 hover:bg-state-hover" onClick={() => { composer.insertMention(selectionPill(reviewId, selection)); composer.focus(); }}>
        Add to chat
      </button>
    </div>
  );
}

function CodemapTab() {
  const target = useFixedTabTarget(CODEMAP_TAB);
  const reviewId = target?.target.reviewId ?? null;
  const { state, error, refresh } = useCodemap(reviewId, reviewId !== null);
  const [filter, setFilter] = useState("");
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and press Codemap to see its structure here.</EmptyState></div>;
  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (state === null || state.status === "building" || state.status === "missing") return <p className="inline-flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" />Building the codemap: parsing changed files and counting references…</p>;
  if (state.status === "failed" || state.codemap === null) return <div className="space-y-2 p-3 text-xs"><p className="text-destructive">{state.error ?? "Codemap failed."}</p><Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div>;
  const c: Codemap = state.codemap;
  const files = c.files.filter((f) => f.symbols.some((s) => s.status !== "unchanged")).filter((f) => filter === "" || f.path.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <span className="text-sm font-semibold">Codemap</span>
        <span className="text-muted-foreground">{c.stats.symbols} symbols · +{c.stats.added} ~{c.stats.modified} -{c.stats.removed} · {c.edges.length} references</span>
        <Button variant="ghost" size="sm" className="ml-auto h-7 px-1.5" onClick={refresh} aria-label="Rebuild codemap"><Icon name="ArrowReloadHorizontal" className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-1.5">
          <div className="font-medium">Reading order</div>
          <ol className="space-y-1.5">
            {c.readingOrder.map((m, i) => (
              <li key={m.module} className="rounded-md border border-border p-2">
                <div className="flex items-center gap-1.5"><span className="text-muted-foreground">{i + 1}.</span><span className="font-mono font-medium">{m.module}</span><span className="ml-auto text-muted-foreground">{m.paths.length} files</span></div>
                <div className="text-[11px] text-muted-foreground">{m.reason}</div>
                <ul className="mt-1 space-y-0.5">
                  {m.paths.map((p) => <li key={p}><button type="button" onClick={() => scrollToFile(p)} className="w-full truncate text-left font-mono text-[11px] hover:underline" title={p}>{p.split("/").slice(2).join("/") || p}</button></li>)}
                </ul>
              </li>
            ))}
          </ol>
        </section>
        <section className="space-y-1.5">
          <div className="font-medium">Hotspots</div>
          <ul className="space-y-0.5">
            {c.hotspots.slice(0, 12).map((h) => (
              <li key={`${h.path}#${h.qualified}`}>
                <button type="button" onClick={() => scrollToFile(h.path)} className="flex w-full items-center gap-2 text-left hover:underline" title={`${h.path} · ${h.changedLines} changed lines · fan-in ${h.fanIn}`}>
                  <span className="w-10 shrink-0 text-right font-mono text-muted-foreground">{Math.round(h.score)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{h.qualified}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-1.5">
          <div className="flex items-center gap-2"><span className="font-medium">Changed symbols</span><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="ml-auto h-7 w-40 text-xs" /></div>
          {files.map((f) => (
            <div key={f.path} className="rounded-md border border-border bg-card">
              <button type="button" onClick={() => scrollToFile(f.path)} className="flex w-full items-center gap-2 border-b border-border/60 px-2 py-1.5 text-left font-mono hover:underline">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="text-muted-foreground">{f.changedLines} lines</span>
              </button>
              <ul className="divide-y divide-border/60">
                {f.symbols.filter((s) => s.status !== "unchanged").map((s) => (
                  <li key={`${s.kind}:${s.qualified}`} className="flex items-center gap-2 px-2 py-1">
                    <span className={cn("w-14 shrink-0 rounded-full border px-1.5 text-center text-[10px] uppercase", s.status === "added" ? "border-primary/50 text-primary" : s.status === "removed" ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")}>{s.status}</span>
                    <span className="text-muted-foreground">{s.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={s.qualified}>{s.qualified}</span>
                    <span className="shrink-0 text-muted-foreground">{s.status === "removed" ? `old ${s.oldStart}-${s.oldEnd}` : `${s.start}-${s.end}`}{s.fanIn > 0 ? ` · ${s.fanIn} refs` : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ReviewsPage({ subPath }: { subPath: string }) {
  const { reviews, error, refetch } = useReviews();
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const [ref, setRef] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [head] = subPath.split("/");
  const reviewId = head !== "" ? head : null;
  if (reviewId !== null) return <ReviewView key={reviewId} reviewId={reviewId} />;
  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (ref.trim() === "") return;
    setOpening(true);
    setOpenError(null);
    try {
      const { review } = await rpc.call("reviews_open", { ref: ref.trim() });
      setRef("");
      refetch();
      navigate.toPluginPanel(PANEL_PATH, { subPath: review.id });
    } catch (cause) {
      setOpenError(describeError(cause));
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="mt-1 text-sm text-muted-foreground">Open a pull request to read it with the diff, the conversation, and an analyst that has the code in front of it.</p>
        <form onSubmit={open} className="mt-6 flex items-center gap-2">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://github.com/owner/repo/pull/123 or owner/repo#123" className="h-10" aria-label="Pull request" />
          <Button type="submit" className="h-10" disabled={opening || ref.trim() === ""}>
            {opening ? <Icon name="Loading" className="size-4 animate-spin" /> : <Icon name="GitPullRequest" className="size-4" />}
            {opening ? "Fetching…" : "Open"}
          </Button>
        </form>
        {openError ? <p className="mt-2 text-sm text-destructive">{openError}</p> : null}
        <div className="mt-10">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
          {error ? <p className="text-sm text-destructive">{error}</p> : reviews === null ? <p className="text-sm text-muted-foreground">Loading…</p> : reviews.length === 0 ? <EmptyState>No reviews yet.</EmptyState> : (
            <ul className="divide-y divide-border/60 rounded-lg border border-border">
              {reviews.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: r.id })} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover">
                    <Icon name="GitPullRequest" className={cn("size-4 shrink-0", r.state === "OPEN" ? "text-primary" : "text-muted-foreground")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{r.owner}/{r.repo} #{r.number} · {r.state.toLowerCase()}{r.pendingCount > 0 ? ` · ${r.pendingCount} pending` : ""}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(r.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Reviews",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: ReviewsPage,
    fixedTabs: [
      { ...INFO_TAB, title: "Info", icon: "Info", layout: "flush", component: InfoTab },
      { ...CHAT_TAB, title: "Chat", icon: "Brain", layout: "flush", component: ChatTab },
      { ...CODEMAP_TAB, title: "Codemap", icon: "Layers", layout: "flush", component: CodemapTab },
    ],
  });
  app.composer.customize({
    id: "code-pills",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "selection", chrome: "bare", component: PillBanner }],
  });
});
