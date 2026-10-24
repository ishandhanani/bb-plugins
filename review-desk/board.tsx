// The board: every tracked pull request as a card under Unreviewed, Changes
// requested, or Babysit, following GitHub's state; drag a card to hold it
// elsewhere until GitHub's state changes. Merged and closed PRs leave the
// columns and wait in a strip at the bottom until removed.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent, FormEvent, ReactNode } from "react";
import { toast } from "sonner";
import { UrlLink, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ReviewSummary, rpcContract } from "./server";
import { BOARD_STAGES, BOARD_STAGE_HINT, BOARD_STAGE_LABEL, type BoardStage } from "./board-spec";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { describeError, timeAgo } from "@/lib/format";

type Contract = typeof rpcContract;
const REVIEW_CHANGED = "review-changed";

/** Open PRs are synced with GitHub when the board opens, at most this often. */
const BOARD_AUTO_REFRESH_MS = 10 * 60 * 1000;
let lastBoardAutoRefresh = 0;

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

function cardTime(card: ReviewSummary): number {
  const t = Date.parse(card.ghUpdatedAt);
  return Number.isNaN(t) ? card.updatedAt : t;
}

type ChipTone = "ok" | "bad" | "strong" | "muted";
const CHIP_TONE: Record<ChipTone, string> = {
  ok: "border-primary/40 text-primary",
  bad: "border-destructive/40 text-destructive",
  strong: "border-foreground/30 text-foreground",
  muted: "border-border text-muted-foreground",
};

function Chip({ icon, tone = "muted", title, children }: { icon?: IconName; tone?: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 tabular-nums", CHIP_TONE[tone])}>
      {icon ? <Icon name={icon} className="size-3" /> : null}
      {children}
    </span>
  );
}

/** What a babysat PR is waiting on, in one chip. */
function babysitVerdict(card: ReviewSummary): { label: string; tone: ChipTone; icon: IconName } {
  const { checks } = card;
  if (card.mergeable === "CONFLICTING") return { label: "Merge conflicts", tone: "bad", icon: "AlertTriangle" };
  if (checks.failed > 0) return { label: `CI failing (${checks.failed})`, tone: "bad", icon: "CircleX" };
  if (checks.pending > 0) return { label: `CI running (${checks.pending})`, tone: "strong", icon: "Clock" };
  if (card.reviewDecision === "REVIEW_REQUIRED") return { label: "Needs a required review", tone: "strong", icon: "UserRound" };
  if (card.isDraft) return { label: "Still a draft", tone: "strong", icon: "GitPullRequestDraft" };
  return { label: "Ready to merge", tone: "ok", icon: "CircleCheck" };
}

/** Checks as a bar, with the failing ones named. */
function CiBar({ card }: { card: ReviewSummary }) {
  const { checks } = card;
  if (checks.total === 0) return <p className="text-[11px] text-muted-foreground">No checks reported yet</p>;
  const tone = checks.failed > 0 ? "bg-destructive" : checks.pending > 0 ? "bg-foreground/40" : "bg-primary";
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10" title={`${checks.passed} passed, ${checks.failed} failing, ${checks.pending} running`}>
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.round((checks.passed / checks.total) * 100)}%` }} />
      </div>
      {card.failingChecks.length > 0 ? (
        <ul className="space-y-0.5">
          {card.failingChecks.map((c, i) => (
            <li key={`${i}-${c.name}`} className="flex items-center gap-1 truncate text-[11px] text-destructive">
              <Icon name="CircleX" className="size-3 shrink-0" />
              {c.url ? <UrlLink href={c.url} className="min-w-0 truncate hover:underline">{c.name}</UrlLink> : <span className="min-w-0 truncate">{c.name}</span>}
            </li>
          ))}
          {checks.failed > card.failingChecks.length ? <li className="text-[11px] text-muted-foreground">and {checks.failed - card.failingChecks.length} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function PrCard({ card, stage, onOpen, onUnpin, onRemove }: { card: ReviewSummary; stage: BoardStage; onOpen: () => void; onUnpin: () => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const { checks } = card;
  const babysit = stage === "babysit";
  const verdict = babysit ? babysitVerdict(card) : null;
  const checksTone: ChipTone = checks.failed > 0 ? "bad" : checks.pending > 0 ? "strong" : "ok";
  const checksIcon: IconName = checks.failed > 0 ? "CircleX" : checks.pending > 0 ? "Clock" : "CircleCheck";
  const prIcon: IconName = card.isDraft ? "GitPullRequestDraft" : "GitPullRequest";
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("text/plain", card.id);
    e.dataTransfer.effectAllowed = "move";
  };
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      data-review-id={card.id}
      className={cn(
        "group relative cursor-pointer rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        verdict?.tone === "ok" ? "border-primary/50" : verdict?.tone === "bad" ? "border-destructive/50" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon name={prIcon} className={cn("mt-0.5 size-4 shrink-0", card.isDraft ? "text-muted-foreground" : "text-primary")} />
        <span className="min-w-0 flex-1 overflow-hidden text-sm font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">{card.title}</span>
        <button
          type="button"
          aria-label="Remove from the board"
          title="Remove from the board"
          onClick={(e) => { e.stopPropagation(); setConfirm(true); }}
          className="-mr-1.5 -mt-1.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {card.owner}/{card.repo} #{card.number}{card.author ? ` · ${card.author}` : ""} · {timeAgo(cardTime(card))}
      </div>
      {babysit ? <div className="mt-2"><CiBar card={card} /></div> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {verdict ? <Chip icon={verdict.icon} tone={verdict.tone}>{verdict.label}</Chip> : null}
        {!babysit && card.isDraft ? <Chip>Draft</Chip> : null}
        {!babysit && checks.total > 0 ? <Chip icon={checksIcon} tone={checksTone} title={`Checks: ${checks.passed} passed, ${checks.failed} failing, ${checks.pending} running`}>{checks.passed}/{checks.total}</Chip> : null}
        {card.unresolvedThreads > 0 ? <Chip icon="MessageSquare" tone="strong" title="Unresolved review threads">{card.unresolvedThreads}</Chip> : null}
        {card.approvals > 0 ? <Chip icon="Check" tone="ok" title="Approvals">{card.approvals}</Chip> : null}
        {card.changesRequested > 0 ? <Chip icon="CircleX" tone="bad" title="Reviewers asking for changes">{card.changesRequested}</Chip> : null}
        {!babysit && card.mergeable === "CONFLICTING" ? <Chip icon="AlertTriangle" tone="bad" title="Merge conflicts with the base branch">conflicts</Chip> : null}
        {card.pendingCount > 0 ? <Chip title="Your comments not yet submitted to GitHub">{card.pendingCount} pending</Chip> : null}
        {babysit && card.lastCommitAt !== null ? <Chip icon="GitBranch" title={`Last commit ${card.lastCommitAt}`}>pushed {timeAgo(card.lastCommitAt)}</Chip> : null}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground"><span className="text-primary">+{card.additions}</span> <span className="text-destructive">−{card.deletions}</span></span>
      </div>
      {card.pinned && card.autoStage !== null ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onUnpin(); }}
          title={`You dragged this card here. GitHub says ${BOARD_STAGE_LABEL[card.autoStage]}; click to follow GitHub again.`}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Icon name="Pin" className="size-3" />Dragged here · GitHub says {BOARD_STAGE_LABEL[card.autoStage]}
        </button>
      ) : null}
      {confirm ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-2 py-1 text-xs" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <span className="min-w-0 flex-1">Remove from the board? Your notes and pending comments on it go too.</span>
          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => { setConfirm(false); onRemove(); }}>Remove</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirm(false)}>Keep</Button>
        </div>
      ) : null}
    </div>
  );
}

function BoardColumn({ stage, count, over, onOver, onLeave, onDrop, children }: { stage: BoardStage; count: number; over: boolean; onOver: () => void; onLeave: () => void; onDrop: (reviewId: string) => void; children: ReactNode }) {
  return (
    <section
      aria-label={BOARD_STAGE_LABEL[stage]}
      data-stage={stage}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!over) onOver(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave(); }}
      onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id !== "") onDrop(id); }}
      className={cn("flex min-h-[180px] flex-col rounded-lg border border-transparent bg-foreground/5 transition-colors", over && "border-primary/50 bg-primary/10")}
    >
      <header className="flex items-center gap-2 px-3 pb-1.5 pt-2.5" title={BOARD_STAGE_HINT[stage]}>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{BOARD_STAGE_LABEL[stage]}</span>
        <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
      </header>
      <div className="flex-1 space-y-2 px-2 pb-2">
        {count === 0 ? <p className="px-1 py-8 text-center text-xs text-muted-foreground">{over ? "Drop here" : BOARD_STAGE_HINT[stage]}</p> : children}
      </div>
    </section>
  );
}

/** Merged and closed PRs, folded away under the columns until removed. */
function ClosedStrip({ cards, onOpen, onRemove, onRemoveAll }: { cards: ReviewSummary[]; onOpen: (reviewId: string) => void; onRemove: (card: ReviewSummary) => void; onRemoveAll: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (cards.length === 0) return null;
  return (
    <div className="border-t border-border px-4 py-2 text-xs" data-closed-strip="">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" aria-expanded={open}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          {cards.length} merged or closed
        </button>
        {open && !confirm ? <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => setConfirm(true)}>Remove all</Button> : null}
        {open && confirm ? (
          <span className="ml-auto inline-flex items-center gap-2">
            <span>Remove {cards.length} from the board?</span>
            <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => { setConfirm(false); onRemoveAll(); }}>Remove</Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirm(false)}>Keep</Button>
          </span>
        ) : null}
      </div>
      {open ? (
        <ul className="mt-2 space-y-1">
          {cards.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <Icon name={c.state === "MERGED" ? "GitMerge" : "GitPullRequestClosed"} className={cn("size-3.5 shrink-0", c.state === "MERGED" ? "text-primary" : "text-destructive")} />
              <button type="button" onClick={() => onOpen(c.id)} className="min-w-0 flex-1 truncate text-left hover:underline">
                {c.title} <span className="text-muted-foreground">{c.owner}/{c.repo} #{c.number} · {c.state.toLowerCase()} {timeAgo(cardTime(c))}</span>
              </button>
              <button type="button" aria-label="Remove from the board" title="Remove from the board" onClick={() => onRemove(c)} className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground">
                <Icon name="X" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function BoardPage({ onOpen }: { onOpen: (reviewId: string) => void }) {
  const { reviews, error, refetch } = useReviews();
  const rpc = useRpc<Contract>();
  const [ref, setRef] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [over, setOver] = useState<BoardStage | null>(null);
  // Cards you just dragged, drawn in their new column until the server's answer arrives.
  const [moves, setMoves] = useState<Record<string, BoardStage>>({});
  useEffect(() => {
    if (reviews === null) return;
    setMoves((m) => {
      const next: Record<string, BoardStage> = {};
      for (const [id, stage] of Object.entries(m)) {
        const card = reviews.find((r) => r.id === id);
        if (card !== undefined && card.stage !== stage) next[id] = stage;
      }
      return Object.keys(next).length === Object.keys(m).length ? m : next;
    });
  }, [reviews]);

  const refresh = useCallback(async (quiet: boolean) => {
    setRefreshing(true);
    try {
      const result = await rpc.call("board_refresh", null);
      refetch();
      if (!quiet) {
        if (result.failed.length === 0) toast.success(`Synced ${result.synced} PR${result.synced === 1 ? "" : "s"} with GitHub`);
        else toast.error(`Synced ${result.synced}; ${result.failed.length} failed: ${result.failed[0].error}`);
      }
    } catch (cause) {
      if (!quiet) toast.error(describeError(cause));
    } finally {
      setRefreshing(false);
    }
  }, [rpc, refetch]);

  // Open PRs that have not been synced for a while are synced when the board opens.
  useEffect(() => {
    if (reviews === null) return;
    const now = Date.now();
    if (now - lastBoardAutoRefresh < BOARD_AUTO_REFRESH_MS) return;
    if (!reviews.some((r) => r.stage !== null && now - r.syncedAt > BOARD_AUTO_REFRESH_MS)) return;
    lastBoardAutoRefresh = now;
    void refresh(true);
  }, [reviews, refresh]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (ref.trim() === "") return;
    setOpening(true);
    setOpenError(null);
    try {
      const { review } = await rpc.call("reviews_open", { ref: ref.trim() });
      setRef("");
      refetch();
      toast.success(`${review.owner}/${review.repo}#${review.number} is on the board`);
    } catch (cause) {
      setOpenError(describeError(cause));
    } finally {
      setOpening(false);
    }
  };

  const move = async (card: ReviewSummary, stage: BoardStage | null) => {
    if (card.autoStage === null) return;
    const shown = moves[card.id] ?? card.stage;
    if (stage !== null && shown === stage) return;
    setMoves((m) => ({ ...m, [card.id]: stage ?? card.autoStage ?? "unreviewed" }));
    try {
      await rpc.call("board_move", { reviewId: card.id, stage: stage === card.autoStage ? null : stage });
      refetch();
    } catch (cause) {
      setMoves((m) => { const next = { ...m }; delete next[card.id]; return next; });
      toast.error(describeError(cause));
    }
  };

  const remove = async (card: ReviewSummary, quiet = false) => {
    try {
      await rpc.call("reviews_remove", { reviewId: card.id });
      if (!quiet) toast.success(`Removed ${card.owner}/${card.repo}#${card.number} from the board`);
      refetch();
    } catch (cause) {
      toast.error(describeError(cause));
    }
  };

  const columns = useMemo(() => {
    const byStage: Record<BoardStage, ReviewSummary[]> = { unreviewed: [], changes_requested: [], babysit: [] };
    const closed: ReviewSummary[] = [];
    for (const r of reviews ?? []) {
      const stage = moves[r.id] ?? r.stage;
      if (stage === null) closed.push(r);
      else byStage[stage].push(r);
    }
    for (const stage of BOARD_STAGES) byStage[stage].sort((a, b) => cardTime(b) - cardTime(a));
    closed.sort((a, b) => cardTime(b) - cardTime(a));
    return { byStage, closed };
  }, [reviews, moves]);
  const openCards = (reviews ?? []).filter((r) => r.stage !== null);
  const oldestSync = openCards.length === 0 ? null : Math.min(...openCards.map((r) => r.syncedAt));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <form onSubmit={add} className="flex min-w-[280px] flex-1 items-center gap-2">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Paste a PR link or owner/repo#123 to put it on the board" className="h-8 text-sm" aria-label="Pull request" />
          <Button type="submit" size="sm" className="h-8" disabled={opening || ref.trim() === ""}>
            {opening ? <Icon name="Loading" className="size-4 animate-spin" /> : <Icon name="Plus" className="size-4" />}
            {opening ? "Fetching…" : "Add"}
          </Button>
        </form>
        <span className="ml-auto text-xs text-muted-foreground">{oldestSync === null ? "" : `Synced ${timeAgo(oldestSync)}`}</span>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => void refresh(false)} disabled={refreshing || reviews === null} title="Sync every open PR with GitHub">
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", refreshing && "animate-spin")} />{refreshing ? "Syncing…" : "Refresh"}
        </Button>
      </div>
      {openError ? <p role="alert" className="px-4 pt-2 text-sm text-destructive">{openError}</p> : null}
      {error ? <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error}</p> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {reviews === null ? <p className="p-6 text-sm text-muted-foreground">Loading…</p> : (
          <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {BOARD_STAGES.map((stage) => (
              <BoardColumn
                key={stage}
                stage={stage}
                count={columns.byStage[stage].length}
                over={over === stage}
                onOver={() => setOver(stage)}
                onLeave={() => setOver((s) => (s === stage ? null : s))}
                onDrop={(id) => {
                  setOver(null);
                  const card = reviews.find((r) => r.id === id);
                  if (card !== undefined) void move(card, stage);
                }}
              >
                {columns.byStage[stage].map((card) => (
                  <PrCard key={card.id} card={card} stage={stage} onOpen={() => onOpen(card.id)} onUnpin={() => void move(card, null)} onRemove={() => void remove(card)} />
                ))}
              </BoardColumn>
            ))}
          </div>
        )}
      </div>
      <ClosedStrip
        cards={columns.closed}
        onOpen={onOpen}
        onRemove={(card) => void remove(card)}
        onRemoveAll={() => {
          void (async () => {
            for (const card of columns.closed) await remove(card, true);
            toast.success(`Removed ${columns.closed.length} merged or closed PR${columns.closed.length === 1 ? "" : "s"}`);
          })();
        }}
      />
    </div>
  );
}
