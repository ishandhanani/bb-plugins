// bb-plugin-review-desk — frontend entry.
//
// The Reviews nav panel: a review list, the PR header, a file rail with a
// codemap view, and the diff column rendered with Pierre diffs so lines can be
// selected and annotated inline with GitHub threads, pending comments and AI
// notes. Fixed side tabs: Conversation (PR body, checks, threads, submit),
// AI notes (passes and findings), Codemap (reading order, hotspots).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  Markdown,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  experimental_FileLink as FileLink,
  experimental_useAppPanel as useAppPanel,
  experimental_useCodeTheme as useCodeTheme,
  experimental_useFixedTabTarget as useFixedTabTarget,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { FileDiff, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import type { AiKind, AiRequest, CodemapState, FileEntry, Note, PendingComment, ProviderOption, Review, ReviewSummary, Severity, Side, rpcContract } from "./server";
import type { Codemap, GhThread } from "./host-contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;

const PANEL_ID = "reviews";
const PANEL_PATH = "reviews";
const REVIEW_CHANGED = "review-changed";

interface ReviewTarget {
  reviewId: string;
  [key: string]: JsonValue;
}
function isReviewTarget(value: JsonValue): value is ReviewTarget {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).reviewId === "string";
}
const CONVERSATION_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "conversation", experimental_target: { validate: isReviewTarget } };
const NOTES_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "ai-notes", experimental_target: { validate: isReviewTarget } };
const CODEMAP_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "codemap", experimental_target: { validate: isReviewTarget } };

// Shiki bundled theme names Pierre can resolve. Anything else falls back.
const SHIKI_THEMES = new Set([
  "andromeeda", "aurora-x", "ayu-dark", "catppuccin-frappe", "catppuccin-latte", "catppuccin-macchiato", "catppuccin-mocha", "dark-plus", "dracula", "dracula-soft",
  "everforest-dark", "everforest-light", "github-dark", "github-dark-default", "github-dark-dimmed", "github-dark-high-contrast", "github-light", "github-light-default",
  "github-light-high-contrast", "gruvbox-dark-hard", "gruvbox-dark-medium", "gruvbox-dark-soft", "gruvbox-light-hard", "gruvbox-light-medium", "gruvbox-light-soft", "houston",
  "kanagawa-dragon", "kanagawa-lotus", "kanagawa-wave", "laserwave", "light-plus", "material-theme", "material-theme-darker", "material-theme-lighter", "material-theme-ocean",
  "material-theme-palenight", "min-dark", "min-light", "monokai", "night-owl", "nord", "one-dark-pro", "one-light", "plastic", "poimandres", "red", "rose-pine", "rose-pine-dawn",
  "rose-pine-moon", "slack-dark", "slack-ochin", "snazzy-light", "solarized-dark", "solarized-light", "synthwave-84", "tokyo-night", "vesper", "vitesse-black", "vitesse-dark", "vitesse-light",
]);

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function payloadReview(payload: unknown): { reviewId: string; what: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { reviewId?: unknown; what?: unknown };
  return typeof p.reviewId === "string" ? { reviewId: p.reviewId, what: typeof p.what === "string" ? p.what : "" } : null;
}

interface ReviewDetail {
  review: Review;
  files: FileEntry[];
  pending: PendingComment[];
  notes: Note[];
  requests: AiRequest[];
  threads: GhThread[];
}

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
  const running = detail?.requests.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refetch, 5000);
    return () => clearInterval(timer);
  }, [running, refetch]);
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

function useProviders() {
  const rpc = useRpc<Contract>();
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  useEffect(() => {
    rpc.call("context_providers").then((r) => setProviders(r.providers.filter((p) => p.available)), () => setProviders([]));
  }, [rpc]);
  return providers;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

const SEVERITY_STYLE: Record<Severity, string> = {
  blocker: "border-destructive text-destructive",
  major: "border-destructive/60 text-destructive",
  minor: "border-foreground/40 text-foreground",
  nit: "border-border text-muted-foreground",
  info: "border-border text-muted-foreground",
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn("rounded-full border px-1.5 py-0 text-[10px] font-medium uppercase", SEVERITY_STYLE[severity])}>{severity}</span>;
}

function timeAgo(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function fileAnchorId(path: string): string {
  return `rd-file-${path.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function scrollToFile(path: string): void {
  document.getElementById(fileAnchorId(path))?.scrollIntoView({ block: "start", behavior: "smooth" });
}

const KIND_LABELS: Record<AiKind, string> = {
  explain: "Explain",
  why: "Why changed",
  risks: "Risks",
  fix: "Suggest fix",
  ask: "Ask",
  pass_summary: "Summary",
  pass_risk: "Risk review",
  pass_perf: "Perf review",
  pass_slop: "Slop review",
  pass_tests: "Test gaps",
  file_summary: "File summary",
};

function ProviderSelect({ providers, value, onChange, className }: { providers: ProviderOption[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cn("h-7 rounded-md border border-input bg-background px-1.5 text-xs", className)} aria-label="AI provider" title="Which agent answers">
      {providers.map((p) => (
        <option key={p.id} value={p.id}>{p.displayName}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Annotations rendered inside the diff
// ---------------------------------------------------------------------------

type Anno =
  | { kind: "thread"; thread: GhThread }
  | { kind: "pending"; pending: PendingComment }
  | { kind: "note"; note: Note }
  | { kind: "composer"; path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; initial: string; noteId: string | null };

interface AnnoActions {
  reviewId: string;
  reply(commentId: number, body: string): Promise<void>;
  resolve(threadId: string, resolve: boolean): Promise<void>;
  savePending(input: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string; noteId: string | null }): Promise<void>;
  updatePending(id: string, body: string): Promise<void>;
  deletePending(id: string): Promise<void>;
  dismissNote(id: string): Promise<void>;
  noteToComment(note: Note): void;
  sendToRoom(text: string): void;
  closeComposer(): void;
}

function ThreadCard({ thread, actions }: { thread: GhThread; actions: AnnoActions }) {
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = thread.comments[0];
  return (
    <div className={cn("my-1 rounded-md border bg-card text-xs", thread.isResolved ? "border-border/60 opacity-70" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <Icon name="Github" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{first?.author ?? "thread"}</span>
        <span className="text-muted-foreground">{thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}</span>
        {thread.isResolved ? <span className="rounded-full border border-border px-1.5 text-[10px]">resolved</span> : null}
        {thread.isOutdated ? <span className="rounded-full border border-border px-1.5 text-[10px]">outdated</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {first?.url ? <UrlLink href={first.url} className="text-muted-foreground hover:text-foreground" title="Open on GitHub"><Icon name="ExternalLink" className="size-3.5" /></UrlLink> : null}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setReply((r) => (r === null ? "" : null))}>Reply</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={async () => { setBusy(true); try { await actions.resolve(thread.id, !thread.isResolved); } finally { setBusy(false); } }}>
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {thread.comments.map((c) => (
          <div key={c.id} className="px-2.5 py-2">
            <div className="mb-1 text-muted-foreground"><span className="font-medium text-foreground">{c.author}</span> · {timeAgo(c.createdAt)}</div>
            <div className="text-sm"><Markdown content={c.body} /></div>
          </div>
        ))}
      </div>
      {reply !== null ? (
        <form
          className="flex flex-col gap-1.5 border-t border-border/60 px-2.5 py-2"
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            const target = first?.databaseId;
            if (!target || reply.trim() === "") return;
            setBusy(true);
            try {
              await actions.reply(target, reply.trim());
              setReply(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" placeholder="Reply on GitHub…" />
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
    <div className="my-1 rounded-md border border-dashed border-foreground/40 bg-card text-xs">
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <Icon name="Edit" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Pending comment</span>
        <span className="text-muted-foreground">not on GitHub yet</span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing((e) => (e === null ? pending.body : null))}>Edit</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => void actions.deletePending(pending.id)}>Delete</Button>
        </span>
      </div>
      {editing === null ? (
        <div className="px-2.5 py-2 text-sm"><Markdown content={pending.body} /></div>
      ) : (
        <form className="flex flex-col gap-1.5 px-2.5 py-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (editing.trim() === "") return; await actions.updatePending(pending.id, editing.trim()); setEditing(null); }}>
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" size="sm" className="h-7">Save</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function NoteCard({ note, actions, compact }: { note: Note; actions: AnnoActions; compact?: boolean }) {
  return (
    <div className={cn("my-1 rounded-md border bg-card text-xs", note.status === "posted" ? "border-border/60 opacity-70" : "border-primary/40")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <Icon name="Brain" className="size-3.5 text-primary" />
        <span className="font-medium">{note.title}</span>
        {note.severity ? <SeverityBadge severity={note.severity} /> : null}
        <span className="text-muted-foreground">{note.providerId}{note.status === "posted" ? " · posted" : ""}</span>
        {compact && note.path ? <span className="font-mono text-muted-foreground">{note.path}{note.startLine ? `:${note.startLine}` : ""}</span> : null}
        <span className="ml-auto flex gap-1">
          {note.status === "draft" && note.path && note.startLine ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => actions.noteToComment(note)} title="Turn into a pending GitHub comment">Add as comment</Button>
          ) : null}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => actions.sendToRoom(`${note.title}${note.path ? ` (${note.path}${note.startLine ? `:${note.startLine}` : ""})` : ""}\n\n${note.body}`)} title="Send to a Roundtable room">To room</Button>
          {note.status !== "dismissed" ? <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => void actions.dismissNote(note.id)}>Dismiss</Button> : null}
        </span>
      </div>
      <div className="px-2.5 py-2 text-sm"><Markdown content={note.body} /></div>
    </div>
  );
}

function ComposerCard({ anno, actions }: { anno: Extract<Anno, { kind: "composer" }>; actions: AnnoActions }) {
  const [body, setBody] = useState(anno.initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="my-1 flex flex-col gap-1.5 rounded-md border border-foreground/50 bg-card px-2.5 py-2 text-xs"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (body.trim() === "") return;
        setBusy(true);
        try {
          await actions.savePending({ path: anno.path, line: anno.line, startLine: anno.startLine, side: anno.side, body: body.trim(), noteId: anno.noteId });
          actions.closeComposer();
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="text-muted-foreground">
        Comment on {anno.path}:{anno.startLine !== null && anno.startLine !== anno.line ? `${anno.startLine}-` : ""}{anno.line} ({anno.side === "LEFT" ? "old" : "new"} side). Saved as pending until you submit the review.
      </div>
      <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" placeholder="Write the comment (Markdown)…" />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={actions.closeComposer}>Cancel</Button>
        <Button type="submit" size="sm" className="h-7" disabled={busy || body.trim() === ""}>Add pending comment</Button>
      </div>
    </form>
  );
}

function Annotation({ anno, actions }: { anno: Anno; actions: AnnoActions }) {
  switch (anno.kind) {
    case "thread": return <ThreadCard thread={anno.thread} actions={actions} />;
    case "pending": return <PendingCard pending={anno.pending} actions={actions} />;
    case "note": return <NoteCard note={anno.note} actions={actions} />;
    case "composer": return <ComposerCard anno={anno} actions={actions} />;
  }
}

// ---------------------------------------------------------------------------
// File card with the Pierre diff
// ---------------------------------------------------------------------------

interface Selection {
  path: string;
  range: SelectedLineRange;
}

interface FileCardProps {
  review: Review;
  file: FileEntry;
  threads: GhThread[];
  notes: Note[];
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
  onAi(kind: AiKind, question?: string): void;
  onSendSelection(): void;
  providers: ProviderOption[];
  providerId: string;
  onProvider(id: string): void;
}

function FileCard(props: FileCardProps) {
  const { review, file, expanded, onToggle, selection, diffStyle, theme, actions, rpc } = props;
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!expanded || !visible || patch !== null || file.binary) return;
    rpc.call("review_patch", { reviewId: review.id, path: file.path }).then(
      (result) => setPatch(result.patch),
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [expanded, visible, patch, file.binary, file.path, review.id, rpc]);

  useEffect(() => {
    setPatch(null);
  }, [review.headSha]);

  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (patch === null || patch.trim() === "") return null;
    try {
      const parsed = parsePatchFiles(patch);
      return parsed[0]?.files[0] ?? null;
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
    for (const note of props.notes) {
      if (note.status === "dismissed" || note.startLine === null) continue;
      list.push({ side: note.side === "old" ? "deletions" : "additions", lineNumber: note.endLine ?? note.startLine, metadata: { kind: "note", note } });
    }
    for (const pending of props.pending) {
      list.push({ side: pending.side === "LEFT" ? "deletions" : "additions", lineNumber: pending.line, metadata: { kind: "pending", pending } });
    }
    if (props.composer) list.push({ side: props.composer.side === "LEFT" ? "deletions" : "additions", lineNumber: props.composer.line, metadata: props.composer });
    return list;
  }, [props.threads, props.notes, props.pending, props.composer]);

  const selected = selection?.path === file.path ? selection.range : null;
  const changed = file.additions + file.deletions;

  const loadDiffFiles = useCallback(
    async (meta: FileDiffMetadata) => {
      const [oldSide, newSide] = await Promise.all([
        rpc.call("review_file", { reviewId: review.id, path: file.path, side: "old" }),
        rpc.call("review_file", { reviewId: review.id, path: file.path, side: "new" }),
      ]);
      return {
        oldFile: oldSide.content === null ? { name: meta.prevName ?? meta.name, contents: "" } : { name: meta.prevName ?? meta.name, contents: oldSide.content },
        newFile: { name: meta.name, contents: newSide.content ?? "" },
      };
    },
    [rpc, review.id, file.path],
  );

  return (
    <div ref={ref} id={fileAnchorId(file.path)} className={cn("scroll-mt-2 rounded-lg border border-border bg-card", file.viewed && "opacity-80")}>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-lg border-b border-border bg-card/95 px-3 py-1.5 text-xs backdrop-blur">
        <button type="button" onClick={onToggle} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" aria-expanded={expanded} aria-label={expanded ? "Collapse file" : "Expand file"}>
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.oldPath && file.oldPath !== file.path ? <span className="text-muted-foreground">{file.oldPath} → </span> : null}
          {file.path}
        </span>
        <span className="text-muted-foreground">{file.status}</span>
        <span className="font-mono"><span className="text-primary">+{file.additions}</span> <span className="text-destructive">-{file.deletions}</span></span>
        {file.unresolvedCount > 0 ? <span className="rounded-full border border-border px-1.5" title="Unresolved GitHub threads"><Icon name="Github" className="mr-0.5 inline size-3" />{file.unresolvedCount}</span> : null}
        {file.noteCount > 0 ? <span className="rounded-full border border-primary/40 px-1.5 text-primary" title="AI notes"><Icon name="Brain" className="mr-0.5 inline size-3" />{file.noteCount}</span> : null}
        {file.pendingCount > 0 ? <span className="rounded-full border border-dashed border-foreground/40 px-1.5" title="Pending comments">{file.pendingCount} pending</span> : null}
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onAi("file_summary")} title="Ask the AI to summarize this file's change">Summarize</Button>
        <FileLink target={{ kind: "host", hostId: review.hostId, path: `${review.worktree}/${file.path}` }} className="text-muted-foreground hover:text-foreground" title="Open the file at the PR head">
          <Icon name="ExternalLink" className="size-3.5" />
        </FileLink>
        <label className="inline-flex items-center gap-1 text-muted-foreground" title="Mark viewed (v)">
          <input type="checkbox" checked={file.viewed} onChange={(e) => props.onViewed(e.target.checked)} className="size-3.5" />
          viewed
        </label>
      </div>
      {selected ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">
            Lines {Math.min(selected.start, selected.end)}-{Math.max(selected.start, selected.end)} ({selected.side === "deletions" ? "old" : "new"})
          </span>
          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => props.onOpenComposer(file.path, selected)}><Icon name="Edit" className="size-3" />Comment</Button>
          <ProviderSelect providers={props.providers} value={props.providerId} onChange={props.onProvider} className="h-6" />
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onAi("explain")}>Explain</Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onAi("why")}>Why</Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onAi("risks")}>Risks</Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onAi("fix")}>Fix</Button>
          {asking ? (
            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (question.trim() === "") return; props.onAi("ask", question.trim()); setQuestion(""); setAsking(false); }}>
              <Input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about these lines…" className="h-6 w-64 text-xs" />
              <Button type="submit" size="sm" className="h-6 px-2 text-xs">Ask</Button>
            </form>
          ) : (
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setAsking(true)}>Ask…</Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={props.onSendSelection} title="Send this range to a Roundtable room">To room</Button>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => props.onSelect(null)}>Clear</Button>
        </div>
      ) : null}
      {!expanded ? null : file.binary ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">Binary file.</div>
      ) : error ? (
        <div className="px-3 py-3 text-xs text-destructive">{error}</div>
      ) : patch === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">{visible ? "Loading diff…" : `${changed} changed lines`}</div>
      ) : fileDiff === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">No textual diff.</div>
      ) : (
        <div className="rd-diff overflow-x-auto text-[12.5px]">
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
// Room picker (send text to a Roundtable room)
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/60 p-4" role="dialog" aria-label="Send to Roundtable room">
      <form
        className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-card p-4 text-sm shadow-lg"
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (roomId === "" || body.trim() === "") return;
          setBusy(true);
          setError(null);
          try {
            await rpc.call("send_to_room", { roomId, text: body.trim(), tags, turns });
            onClose();
          } catch (cause) {
            setError(describeError(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center justify-between">
          <span className="font-semibold">Send to a Roundtable room</span>
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
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
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
// Review view
// ---------------------------------------------------------------------------

function ReviewView({ reviewId }: { reviewId: string }) {
  const { rpc, detail, error, refetch } = useReview(reviewId);
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const providers = useProviders();
  const codeTheme = useCodeTheme();
  const [providerId, setProviderId] = useState("");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [rail, setRail] = useState<"files" | "codemap">("files");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [composer, setComposer] = useState<Extract<Anno, { kind: "composer" }> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedOverride, setExpandedOverride] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roomText, setRoomText] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [railOpen, setRailOpen] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const codemap = useCodemap(reviewId, rail === "codemap");

  // Default the file rail by available width; the user can still toggle it.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setRailOpen((current) => (current === null ? width >= 900 : current));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (providerId === "" && providers[0]) setProviderId(providers[0].id);
  }, [providers, providerId]);

  const theme = useMemo(() => {
    const name = codeTheme.name;
    const known = SHIKI_THEMES.has(name);
    return {
      dark: known && codeTheme.mode === "dark" ? name : "github-dark",
      light: known && codeTheme.mode === "light" ? name : "github-light",
      mode: codeTheme.mode,
    };
  }, [codeTheme.name, codeTheme.mode]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const actions = useMemo<AnnoActions>(
    () => ({
      reviewId,
      reply: async (commentId, body) => { await rpc.call("thread_reply", { reviewId, commentId, body }); refetch(); },
      resolve: async (threadId, resolve) => { await rpc.call("thread_resolve", { reviewId, threadId, resolve }); refetch(); },
      savePending: async (input) => { await rpc.call("pending_add", { reviewId, ...input }); refetch(); },
      updatePending: async (id, body) => { await rpc.call("pending_update", { id, body }); refetch(); },
      deletePending: async (id) => { await rpc.call("pending_delete", { id }); refetch(); },
      dismissNote: async (id) => { await rpc.call("note_update", { id, status: "dismissed" }); refetch(); },
      noteToComment: (note) => {
        if (!note.path || !note.startLine) return;
        setComposer({ kind: "composer", path: note.path, line: note.endLine ?? note.startLine, startLine: note.startLine !== (note.endLine ?? note.startLine) ? note.startLine : null, side: note.side === "old" ? "LEFT" : "RIGHT", initial: `${note.title}\n\n${note.body}`, noteId: note.id });
        scrollToFile(note.path);
      },
      sendToRoom: (text) => setRoomText(text),
      closeComposer: () => setComposer(null),
    }),
    [rpc, reviewId, refetch],
  );

  const openComposer = (path: string, range: SelectedLineRange) => {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setComposer({ kind: "composer", path, line: end, startLine: start !== end ? start : null, side: (range.side ?? "additions") === "deletions" ? "LEFT" : "RIGHT", initial: "", noteId: null });
  };

  const askAi = (path: string | null, range: SelectedLineRange | null, kind: AiKind, question?: string) => {
    if (providerId === "") {
      setActionError("No AI provider is available.");
      return;
    }
    void run("ai", async () => {
      await rpc.call("ai_ask", {
        reviewId,
        kind,
        providerId,
        path,
        startLine: range ? Math.min(range.start, range.end) : null,
        endLine: range ? Math.max(range.start, range.end) : null,
        side: range ? ((range.side ?? "additions") === "deletions" ? "old" : "new") : "new",
        question: question ?? null,
      });
      panel.openFixedTab({ surface: { kind: "current" }, tab: NOTES_TAB, target: { reviewId } });
      refetch();
    });
  };

  if (error !== null) return <div className="p-4"><p role="alert" className="text-sm text-destructive">{error}</p></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading review…</EmptyState></div>;

  const { review, files } = detail;
  const threadsByPath = new Map<string, GhThread[]>();
  for (const t of detail.threads) threadsByPath.set(t.path, [...(threadsByPath.get(t.path) ?? []), t]);
  const notesByPath = new Map<string, Note[]>();
  for (const n of detail.notes) if (n.path) notesByPath.set(n.path, [...(notesByPath.get(n.path) ?? []), n]);
  const pendingByPath = new Map<string, PendingComment[]>();
  for (const p of detail.pending) pendingByPath.set(p.path, [...(pendingByPath.get(p.path) ?? []), p]);

  const isExpanded = (f: FileEntry, index: number) => {
    if (collapsed.has(f.path)) return false;
    if (expandedOverride.has(f.path)) return true;
    return index < 60 && f.additions + f.deletions <= 800;
  };
  const toggle = (path: string, expanded: boolean) => {
    if (expanded) setCollapsed((s) => new Set(s).add(path));
    else setCollapsed((s) => { const n = new Set(s); n.delete(path); return n; });
    if (!expanded) setExpandedOverride((s) => new Set(s).add(path));
  };
  const viewedCount = files.filter((f) => f.viewed).length;
  const checksOk = review.checks.filter((c) => (c.conclusion ?? "").toLowerCase() === "success").length;
  const checksBad = review.checks.filter((c) => ["failure", "error", "timed_out", "cancelled"].includes((c.conclusion ?? "").toLowerCase())).length;
  const runningRequests = detail.requests.filter((r) => r.status === "running");
  const filteredFiles = filter.trim() === "" ? files : files.filter((f) => f.path.toLowerCase().includes(filter.trim().toLowerCase()));

  const selectionText = () => {
    if (!selection) return "";
    const s = Math.min(selection.range.start, selection.range.end);
    const e = Math.max(selection.range.start, selection.range.end);
    return `${review.owner}/${review.repo}#${review.number} ${selection.path}:${s}-${e} (${(selection.range.side ?? "additions") === "deletions" ? "old" : "new"} side, head ${shortSha(review.headSha)})\n\nPlease look at this range.`;
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => setRailOpen((v) => !v)} aria-label={railOpen ? "Hide file list" : "Show file list"} aria-pressed={railOpen === true}>
          <Icon name="PanelLeft" className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex min-w-0 items-center gap-2">
            <UrlLink href={review.url} className="min-w-0 truncate text-sm font-semibold hover:underline" title={review.title}>{review.title}</UrlLink>
            <span className="text-muted-foreground">{review.owner}/{review.repo}#{review.number}</span>
            <span className={cn("rounded-full border px-1.5 py-0 text-[10px] uppercase", review.state === "OPEN" ? "border-primary/50 text-primary" : "border-border text-muted-foreground")}>{review.isDraft ? "draft" : review.state}</span>
            {review.reviewDecision ? <span className="rounded-full border border-border px-1.5 py-0 text-[10px]">{review.reviewDecision.replace(/_/g, " ").toLowerCase()}</span> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-muted-foreground">
            {review.author ? <span>by {review.author}</span> : null}
            <span className="font-mono">{review.baseRefName} ← {review.headRefName} @ {shortSha(review.headSha)}</span>
            <span><span className="text-primary">+{review.additions}</span> <span className="text-destructive">-{review.deletions}</span> · {files.length} files · {viewedCount} viewed</span>
            {review.checks.length > 0 ? <span title={review.checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join("\n")}>checks {checksOk} ok{checksBad > 0 ? `, ${checksBad} failing` : ""}</span> : null}
            <span>synced {timeAgo(review.syncedAt)}</span>
          </div>
        </div>
        {runningRequests.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" />{runningRequests.length} AI request{runningRequests.length === 1 ? "" : "s"}</span>
        ) : null}
        <select value={diffStyle} onChange={(e) => setDiffStyle(e.target.value as "unified" | "split")} className="h-7 rounded-md border border-input bg-background px-1.5 text-xs" aria-label="Diff style">
          <option value="unified">Unified</option>
          <option value="split">Split</option>
        </select>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void run("sync", async () => { await rpc.call("reviews_sync", { reviewId }); refetch(); })} disabled={busy !== null}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", busy === "sync" && "animate-spin")} />Sync
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: NOTES_TAB, target: { reviewId } })}>
          <Icon name="Brain" className="size-3.5" />AI
        </Button>
        <Button size="sm" className="h-7 text-xs" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: CONVERSATION_TAB, target: { reviewId } })}>
          <Icon name="Github" className="size-3.5" />Review{detail.pending.length > 0 ? ` (${detail.pending.length} pending)` : ""}
        </Button>
        <Button variant="ghost" size="sm" className="h-7" aria-label="Remove review from the list" onClick={() => { if (window.confirm("Remove this review from Review Desk? The worktree stays on disk.")) void run("remove", async () => { await rpc.call("reviews_remove", { reviewId }); navigate.toPluginPanel(PANEL_PATH, { replace: true }); }); }}>
          <Icon name="Trash2" className="size-3.5" />
        </Button>
      </header>
      {actionError ? <p role="alert" className="border-b border-border px-4 py-1.5 text-xs text-destructive">{actionError}</p> : null}

      <div className="flex min-h-0 flex-1">
        <aside className={cn("flex w-64 shrink-0 flex-col border-r border-border", railOpen !== true && "hidden")}>
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
            <button type="button" onClick={() => setRail("files")} className={cn("rounded px-2 py-1", rail === "files" ? "bg-state-active font-medium" : "text-muted-foreground hover:bg-state-hover")}>Files {files.length}</button>
            <button type="button" onClick={() => setRail("codemap")} className={cn("rounded px-2 py-1", rail === "codemap" ? "bg-state-active font-medium" : "text-muted-foreground hover:bg-state-hover")}>Codemap</button>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: CODEMAP_TAB, target: { reviewId } })} title="Open the codemap detail tab"><Icon name="PanelRight" className="size-3.5" /></Button>
          </div>
          {rail === "files" ? (
            <>
              <div className="border-b border-border px-2 py-1.5">
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="h-7 text-xs" />
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto py-1 text-xs">
                {filteredFiles.map((f) => (
                  <li key={f.path}>
                    <button type="button" onClick={() => { setExpandedOverride((s) => new Set(s).add(f.path)); setCollapsed((s) => { const n = new Set(s); n.delete(f.path); return n; }); scrollToFile(f.path); }} className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-state-hover">
                      <span className={cn("size-1.5 shrink-0 rounded-full", f.viewed ? "bg-primary" : "bg-muted-foreground/30")} />
                      <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>{f.path}</span>
                      {f.unresolvedCount > 0 ? <span className="text-muted-foreground" title="Unresolved threads">{f.unresolvedCount}</span> : null}
                      {f.noteCount > 0 ? <Icon name="Brain" className="size-3 text-primary" /> : null}
                      <span className="font-mono text-[10px]"><span className="text-primary">+{f.additions}</span> <span className="text-destructive">-{f.deletions}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <CodemapRail state={codemap.state} error={codemap.error} onRefresh={codemap.refresh} />
          )}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex w-full min-w-0 flex-col gap-3 p-3">
            {files.length === 0 ? <EmptyState>No changed files.</EmptyState> : null}
            {files.map((f, index) => (
              <FileCard
                key={f.path}
                review={review}
                file={f}
                threads={threadsByPath.get(f.path) ?? []}
                notes={notesByPath.get(f.path) ?? []}
                pending={pendingByPath.get(f.path) ?? []}
                composer={composer?.path === f.path ? composer : null}
                selection={selection}
                onSelect={setSelection}
                onOpenComposer={openComposer}
                expanded={isExpanded(f, index)}
                onToggle={() => toggle(f.path, isExpanded(f, index))}
                onViewed={(viewed) => void run("viewed", async () => { await rpc.call("viewed_set", { reviewId, path: f.path, viewed }); refetch(); })}
                diffStyle={diffStyle}
                theme={theme}
                actions={actions}
                rpc={rpc}
                onAi={(kind, question) => askAi(f.path, kind === "file_summary" ? null : selection?.path === f.path ? selection.range : null, kind, question)}
                onSendSelection={() => setRoomText(selectionText())}
                providers={providers}
                providerId={providerId}
                onProvider={setProviderId}
              />
            ))}
          </div>
        </main>
      </div>
      {roomText !== null ? <RoomSender text={roomText} onClose={() => setRoomText(null)} /> : null}
    </div>
  );
}

function CodemapRail({ state, error, onRefresh }: { state: CodemapState | null; error: string | null; onRefresh: () => void }) {
  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (state === null) return <p className="p-3 text-xs text-muted-foreground">Loading…</p>;
  if (state.status === "building" || state.status === "missing") return <p className="inline-flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" />Building the codemap (parsing changed files, counting references)…</p>;
  if (state.status === "failed" || state.codemap === null) return <div className="space-y-2 p-3 text-xs"><p className="text-destructive">{state.error ?? "Codemap failed."}</p><Button size="sm" variant="outline" onClick={onRefresh}>Retry</Button></div>;
  const c = state.codemap;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto text-xs">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5 text-muted-foreground">
        <span>{c.stats.symbols} symbols · +{c.stats.added} ~{c.stats.modified} -{c.stats.removed} · {c.engine}</span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={onRefresh} aria-label="Rebuild codemap"><Icon name="ArrowReloadHorizontal" className="size-3" /></Button>
      </div>
      <div className="px-2 py-1.5 font-medium">Reading order</div>
      <ol className="space-y-1 px-2 pb-2">
        {c.readingOrder.map((m, i) => (
          <li key={m.module} className="rounded border border-border p-1.5">
            <div className="flex items-center gap-1.5"><span className="text-muted-foreground">{i + 1}.</span><span className="font-mono font-medium">{m.module}</span><span className="ml-auto text-muted-foreground">{m.paths.length}</span></div>
            <div className="text-[11px] text-muted-foreground">{m.reason}</div>
            <ul className="mt-1 space-y-0.5">
              {m.paths.map((p) => (
                <li key={p}><button type="button" onClick={() => scrollToFile(p)} className="w-full truncate text-left font-mono text-[11px] hover:underline" title={p}>{p.split("/").slice(2).join("/") || p}</button></li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div className="px-2 py-1.5 font-medium">Hotspots</div>
      <ul className="space-y-0.5 px-2 pb-3">
        {c.hotspots.slice(0, 12).map((h) => (
          <li key={`${h.path}#${h.qualified}`}>
            <button type="button" onClick={() => scrollToFile(h.path)} className="flex w-full items-center gap-1.5 text-left hover:underline" title={`${h.path} · ${h.changedLines} changed lines · fan-in ${h.fanIn}`}>
              <span className="w-8 shrink-0 text-right font-mono text-muted-foreground">{h.score}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{h.qualified}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fixed tabs
// ---------------------------------------------------------------------------

function ConversationTab() {
  const target = useFixedTabTarget(CONVERSATION_TAB);
  const reviewId = target?.target.reviewId ?? null;
  const { rpc, detail, refetch } = useReview(reviewId);
  const [conversation, setConversation] = useState<{ comments: { id: number; author: string; body: string; createdAt: string; url: string }[]; reviews: { id: number; author: string; state: string; body: string; submittedAt: string | null; url: string }[] } | null>(null);
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback((refresh = false) => {
    if (reviewId === null) return;
    rpc.call("review_conversation", { reviewId, refresh }).then((r) => setConversation({ comments: r.comments, reviews: r.reviews }), () => undefined);
  }, [rpc, reviewId]);
  useEffect(() => { load(); }, [load]);
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and press Review to see its conversation here.</EmptyState></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading…</EmptyState></div>;
  const { review, pending, threads } = detail;
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Submit review</span>
            <span className="text-muted-foreground">{pending.length} pending comment{pending.length === 1 ? "" : "s"}</span>
          </div>
          {pending.length > 0 ? (
            <ul className="space-y-1">
              {pending.map((p) => (
                <li key={p.id} className="rounded border border-dashed border-foreground/40 px-2 py-1">
                  <button type="button" onClick={() => scrollToFile(p.path)} className="font-mono hover:underline">{p.path}:{p.startLine && p.startLine !== p.line ? `${p.startLine}-` : ""}{p.line}</button>
                  <div className="truncate text-muted-foreground">{p.body.split("\n")[0]}</div>
                </li>
              ))}
            </ul>
          ) : null}
          <form className="space-y-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); setBusy(true); setMessage(null); try { const r = await rpc.call("review_submit", { reviewId, event, body }); setMessage(`Submitted ${r.posted} comment${r.posted === 1 ? "" : "s"}${r.url ? ` · ${r.url}` : ""}`); setBody(""); refetch(); load(true); } catch (cause) { setMessage(describeError(cause)); } finally { setBusy(false); } }}>
            <div className="flex flex-wrap gap-2">
              {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((ev) => (
                <label key={ev} className="inline-flex items-center gap-1"><input type="radio" name="event" checked={event === ev} onChange={() => setEvent(ev)} />{ev.replace("_", " ").toLowerCase()}</label>
              ))}
            </div>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Review body (optional for comment reviews)" className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={busy || (pending.length === 0 && body.trim() === "")}><Icon name="Github" className="size-3.5" />Submit to GitHub</Button>
              {message ? <span className="text-muted-foreground">{message}</span> : null}
            </div>
          </form>
        </section>

        <section className="space-y-1.5">
          <div className="text-sm font-semibold">Description</div>
          <div className="rounded-md border border-border bg-card p-2 text-sm">{review.body.trim() === "" ? <span className="text-muted-foreground">No description.</span> : <Markdown content={review.body} />}</div>
          {review.labels.length > 0 ? <div className="flex flex-wrap gap-1">{review.labels.map((l) => <span key={l} className="rounded-full border border-border px-1.5">{l}</span>)}</div> : null}
        </section>

        {review.checks.length > 0 ? (
          <section className="space-y-1">
            <div className="text-sm font-semibold">Checks</div>
            <ul className="space-y-0.5">
              {review.checks.map((c, i) => (
                <li key={`${c.name}-${i}`} className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", (c.conclusion ?? "").toLowerCase() === "success" ? "bg-primary" : ["failure", "error"].includes((c.conclusion ?? "").toLowerCase()) ? "bg-destructive" : "bg-muted-foreground/40")} />
                  {c.url ? <UrlLink href={c.url} className="truncate hover:underline">{c.name}</UrlLink> : <span className="truncate">{c.name}</span>}
                  <span className="ml-auto text-muted-foreground">{c.conclusion ?? c.status}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-1.5">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Review threads ({threads.filter((t) => !t.isResolved).length} open)</span><Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => void rpc.call("review_threads_refresh", { reviewId }).then(() => refetch())} aria-label="Refresh threads"><Icon name="ArrowReloadHorizontal" className="size-3" /></Button></div>
          <ul className="space-y-1">
            {threads.filter((t) => !t.isResolved).map((t) => (
              <li key={t.id} className="rounded border border-border px-2 py-1">
                <button type="button" onClick={() => scrollToFile(t.path)} className="font-mono hover:underline">{t.path}{t.line ? `:${t.line}` : ""}</button>
                <div className="truncate text-muted-foreground">{t.comments[0]?.author}: {t.comments[0]?.body.split("\n")[0]}</div>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Conversation</span><Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => load(true)} aria-label="Refresh conversation"><Icon name="ArrowReloadHorizontal" className="size-3" /></Button></div>
          {conversation === null ? <p className="text-muted-foreground">Loading…</p> : (
            <ul className="space-y-1.5">
              {conversation.reviews.map((r) => (
                <li key={`r-${r.id}`} className="rounded border border-border bg-card p-2">
                  <div className="text-muted-foreground"><span className="font-medium text-foreground">{r.author}</span> {r.state.replace(/_/g, " ").toLowerCase()}{r.submittedAt ? ` · ${timeAgo(r.submittedAt)}` : ""}</div>
                  {r.body.trim() !== "" ? <div className="mt-1 text-sm"><Markdown content={r.body} /></div> : null}
                </li>
              ))}
              {conversation.comments.map((c) => (
                <li key={`c-${c.id}`} className="rounded border border-border bg-card p-2">
                  <div className="text-muted-foreground"><span className="font-medium text-foreground">{c.author}</span> · {timeAgo(c.createdAt)}</div>
                  <div className="mt-1 text-sm"><Markdown content={c.body} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function NotesTab() {
  const target = useFixedTabTarget(NOTES_TAB);
  const reviewId = target?.target.reviewId ?? null;
  const { rpc, detail, refetch } = useReview(reviewId);
  const providers = useProviders();
  const [providerId, setProviderId] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
  const [roomText, setRoomText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (providerId === "" && providers[0]) setProviderId(providers[0].id); }, [providers, providerId]);
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and press AI to run passes and read notes here.</EmptyState></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading…</EmptyState></div>;
  const actions: AnnoActions = {
    reviewId,
    reply: async () => undefined,
    resolve: async () => undefined,
    savePending: async (input) => { await rpc.call("pending_add", { reviewId, ...input }); refetch(); },
    updatePending: async () => undefined,
    deletePending: async () => undefined,
    dismissNote: async (id) => { await rpc.call("note_update", { id, status: "dismissed" }); refetch(); },
    noteToComment: async (note) => {
      if (!note.path || !note.startLine) return;
      await rpc.call("pending_add", { reviewId, path: note.path, line: note.endLine ?? note.startLine, startLine: null, side: note.side === "old" ? "LEFT" : "RIGHT", body: `${note.title}\n\n${note.body}`, noteId: note.id });
      refetch();
    },
    sendToRoom: (text) => setRoomText(text),
    closeComposer: () => undefined,
  };
  const passes: AiKind[] = ["pass_summary", "pass_risk", "pass_perf", "pass_slop", "pass_tests"];
  const runPass = (kind: AiKind) => {
    if (providerId === "") return;
    rpc.call("ai_ask", { reviewId, kind, providerId }).then(() => refetch(), (c: unknown) => setError(describeError(c)));
  };
  const notes = detail.notes.filter((n) => showDismissed || n.status !== "dismissed");
  const general = notes.filter((n) => n.path === null || n.kind === "summary");
  const anchored = notes.filter((n) => n.path !== null && n.kind !== "summary");
  const byPath = new Map<string, Note[]>();
  for (const n of anchored) byPath.set(n.path as string, [...(byPath.get(n.path as string) ?? []), n]);
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Passes</span>
          <ProviderSelect providers={providers} value={providerId} onChange={setProviderId} />
          <label className="ml-auto inline-flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />show dismissed</label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {passes.map((k) => <Button key={k} size="sm" variant="outline" className="h-7 text-xs" onClick={() => runPass(k)} disabled={providerId === ""}>{KIND_LABELS[k]}</Button>)}
        </div>
        {error ? <p className="text-destructive">{error}</p> : null}
        {detail.requests.filter((r) => r.status === "running").map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-muted-foreground">
            <Icon name="Loading" className="size-3.5 animate-spin" />
            <span>{KIND_LABELS[r.kind]}{r.path ? ` · ${r.path}${r.startLine ? `:${r.startLine}` : ""}` : ""} · {r.providerId} · {timeAgo(r.createdAt)}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => void rpc.call("ai_cancel", { requestId: r.id }).then(() => refetch())}>Cancel</Button>
          </div>
        ))}
        {detail.requests.filter((r) => r.status === "failed").slice(0, 3).map((r) => (
          <div key={r.id} className="text-destructive">{KIND_LABELS[r.kind]} failed: {r.error}</div>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {notes.length === 0 ? <EmptyState>No notes yet. Select lines in the diff and press Explain, or run a pass above.</EmptyState> : null}
        {general.map((n) => <NoteCard key={n.id} note={n} actions={actions} compact />)}
        {[...byPath.entries()].map(([path, list]) => (
          <div key={path} className="space-y-1">
            <button type="button" onClick={() => scrollToFile(path)} className="font-mono text-muted-foreground hover:underline">{path}</button>
            {list.map((n) => <NoteCard key={n.id} note={n} actions={actions} compact />)}
          </div>
        ))}
      </div>
      {roomText !== null ? <RoomSender text={roomText} onClose={() => setRoomText(null)} /> : null}
    </div>
  );
}

function CodemapTab() {
  const target = useFixedTabTarget(CODEMAP_TAB);
  const reviewId = target?.target.reviewId ?? null;
  const { state, error, refresh } = useCodemap(reviewId, reviewId !== null);
  const [filter, setFilter] = useState("");
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and choose Codemap to see its structure here.</EmptyState></div>;
  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (state === null || state.status === "building" || state.status === "missing") return <p className="inline-flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" />Building the codemap…</p>;
  if (state.status === "failed" || state.codemap === null) return <div className="space-y-2 p-3 text-xs"><p className="text-destructive">{state.error ?? "Codemap failed."}</p><Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div>;
  const c: Codemap = state.codemap;
  const files = c.files.filter((f) => f.symbols.some((s) => s.status !== "unchanged")).filter((f) => filter === "" || f.path.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <span className="text-sm font-semibold">Codemap</span>
        <span className="text-muted-foreground">{c.engine} · {c.stats.files} files · {c.stats.symbols} symbols · {c.edges.length} references{c.stats.parseFailures > 0 ? ` · ${c.stats.parseFailures} parse fallbacks` : ""}</span>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="ml-auto h-7 w-40 text-xs" />
        <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={refresh} aria-label="Rebuild codemap"><Icon name="ArrowReloadHorizontal" className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {files.map((f) => (
          <div key={f.path} className="rounded-md border border-border bg-card">
            <button type="button" onClick={() => scrollToFile(f.path)} className="flex w-full items-center gap-2 border-b border-border/60 px-2 py-1.5 text-left font-mono hover:underline">
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-muted-foreground">{f.lang ?? "text"} · {f.changedLines} lines</span>
            </button>
            <ul className="divide-y divide-border/60">
              {f.symbols.filter((s) => s.status !== "unchanged").map((s) => (
                <li key={`${s.kind}:${s.qualified}`} className="flex flex-wrap items-center gap-2 px-2 py-1">
                  <span className={cn("w-14 shrink-0 rounded-full border px-1.5 text-center text-[10px] uppercase", s.status === "added" ? "border-primary/50 text-primary" : s.status === "removed" ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")}>{s.status}</span>
                  <span className="text-muted-foreground">{s.kind}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={s.qualified}>{s.qualified}</span>
                  <span className="text-muted-foreground">{s.status === "removed" ? `old ${s.oldStart}-${s.oldEnd}` : `${s.start}-${s.end}`} · Δ{s.changedLines}{s.fanIn > 0 ? ` · fan-in ${s.fanIn}` : ""}{s.refs.length > 0 ? ` · uses ${s.refs.length}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
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
  if (reviewId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => navigate.toPluginPanel(PANEL_PATH)} aria-label="Back to reviews">
            <Icon name="ChevronLeft" className="size-3.5" />
            Reviews
          </Button>
          {reviews && reviews.length > 1 ? (
            <select value={reviewId} onChange={(e) => navigate.toPluginPanel(PANEL_PATH, { subPath: e.target.value })} className="h-6 max-w-xs truncate rounded-md border border-input bg-background px-1.5 text-xs" aria-label="Switch review">
              {reviews.map((r) => <option key={r.id} value={r.id}>{r.owner}/{r.repo}#{r.number} {r.title}</option>)}
            </select>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <ReviewView key={reviewId} reviewId={reviewId} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <form onSubmit={open} className="space-y-1.5 border-b border-border p-2">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PR URL or owner/repo#123" className="h-8 text-xs" aria-label="Pull request" />
          <Button type="submit" size="sm" className="h-7 w-full text-xs" disabled={opening || ref.trim() === ""}>
            {opening ? <Icon name="Loading" className="size-3.5 animate-spin" /> : <Icon name="GitPullRequest" className="size-3.5" />}
            {opening ? "Fetching PR and worktree…" : "Open review"}
          </Button>
          {openError ? <p className="text-xs text-destructive">{openError}</p> : null}
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {error ? <p className="px-2 text-xs text-destructive">{error}</p> : reviews === null ? <p className="px-2 text-xs text-muted-foreground">Loading…</p> : reviews.length === 0 ? <p className="px-2 text-xs text-muted-foreground">No reviews yet.</p> : (
            <ul className="space-y-0.5">
              {reviews.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: r.id })} aria-current={r.id === reviewId ? "page" : undefined} className={cn("w-full rounded-md px-2.5 py-2 text-left hover:bg-state-hover", r.id === reviewId && "bg-state-active")}>
                    <div className="truncate text-sm font-medium">{r.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.owner}/{r.repo}#{r.number} · {r.state.toLowerCase()}{r.pendingCount > 0 ? ` · ${r.pendingCount} pending` : ""}{r.noteCount > 0 ? ` · ${r.noteCount} notes` : ""}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="p-6"><EmptyState>Paste a pull request URL to start. Review Desk fetches the PR into a detached worktree, renders the diff with inline GitHub threads, and lets you ask an AI about any selection.</EmptyState></div>
      </main>
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
      { ...CONVERSATION_TAB, title: "Review", icon: "Github", layout: "flush", component: ConversationTab },
      { ...NOTES_TAB, title: "AI notes", icon: "Brain", layout: "flush", component: NotesTab },
      { ...CODEMAP_TAB, title: "Codemap", icon: "Layers", layout: "flush", component: CodemapTab },
    ],
  });
});
