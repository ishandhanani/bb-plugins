// The board: every tracked pull request as a card under Unreviewed, AI
// review, Human review, Changes requested, or Babysit, following the PR
// factory and GitHub's state; drag a card to move it. Merged and closed PRs
// leave the columns and wait in a strip at the bottom until removed.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent, FormEvent, ReactNode } from "react";
import { toast } from "sonner";
import { UrlLink, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ReviewSummary, rpcContract } from "./server";
import { BOARD_LANES, BOARD_STAGES, BOARD_STAGE_HINT, BOARD_STAGE_LABEL, stageLabel, type BoardLane, type BoardStage } from "./board-spec";
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

/** A newly added PR's countdown to its first job; drag the card before it ends to send it elsewhere. */
function StartCountdown({ startsAt }: { startsAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((startsAt - now) / 1000));
  return <Chip icon="Clock" tone="strong" title="Drag the card to another column before this ends and the factory does that instead">starts in {left}s</Chip>;
}

const WORKING = ["review", "verify", "recheck"];

/** The one thing worth knowing about a card: what needs you, what is running, or what CI says. Null when nothing does. */
function cardStatus(card: ReviewSummary, stage: BoardStage): { label: string; tone: ChipTone; icon: IconName; title?: string } | null {
  const f = card.factory;
  if (f?.needsYou) return { label: "Needs you", tone: "bad", icon: "BellDot", title: f.needsYou };
  if (f?.final && WORKING.includes(f.final.status)) return { label: "Final check", tone: "strong", icon: "Clock" };
  if (f?.fix?.status === "running") return { label: f.fix.kind === "deslop" ? "Deslopping" : f.fix.kind === "sync" ? "Merging base" : "Fixing", tone: "strong", icon: "Clock" };
  if (f?.roundStatus === "running" || f?.roundStatus === "queued") return { label: `AI round ${f.round}`, tone: "strong", icon: "Clock" };
  if (f?.roundStatus === "failed") return { label: "Round failed", tone: "bad", icon: "AlertTriangle", title: f.error ?? undefined };
  if (card.mergeable === "CONFLICTING") return { label: "Conflicts", tone: "bad", icon: "AlertTriangle" };
  if (card.checks.failed > 0) return { label: `CI ${card.checks.failed} failing`, tone: "bad", icon: "CircleX", title: card.failingChecks.map((c) => c.name).join("\n") };
  if (card.checks.pending > 0) return { label: "CI running", tone: "muted", icon: "Clock" };
  if (stage === "babysit" && card.checks.total > 0 && !card.isDraft) return { label: "Ready to merge", tone: "ok", icon: "CircleCheck" };
  return null;
}

function PrCard({ card, stage, onOpen, onRemove }: { card: ReviewSummary; stage: BoardStage; onOpen: () => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const status = cardStatus(card, stage);
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
      title={card.title}
      className="group relative cursor-pointer rounded-md border border-border bg-card px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.title}</span>
        <button
          type="button"
          aria-label="Remove from the board"
          title="Remove from the board"
          onClick={(e) => { e.stopPropagation(); setConfirm(true); }}
          className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">#{card.number} · {card.repo}{card.isDraft ? " · draft" : ""} · {timeAgo(cardTime(card))}</span>
        {card.factory?.startsAt != null ? <StartCountdown startsAt={card.factory.startsAt} /> : status ? <Chip icon={status.icon} tone={status.tone} title={status.title}>{status.label}</Chip> : null}
      </div>
      {confirm ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-2 py-1 text-xs" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <span className="min-w-0 flex-1">Remove from the board?</span>
          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => { setConfirm(false); onRemove(); }}>Remove</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirm(false)}>Keep</Button>
        </div>
      ) : null}
    </div>
  );
}

function BoardColumn({ stage, label, count, over, onOver, onLeave, onDrop, children }: { stage: BoardStage; label: string; count: number; over: boolean; onOver: () => void; onLeave: () => void; onDrop: (reviewId: string) => void; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      data-stage={stage}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!over) onOver(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave(); }}
      onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id !== "") onDrop(id); }}
      className={cn("flex min-h-[180px] flex-col rounded-lg border border-transparent bg-foreground/5 transition-colors", over && "border-primary/50 bg-primary/10")}
    >
      <header className="flex items-center gap-2 px-3 pb-1.5 pt-2.5" title={BOARD_STAGE_HINT[stage]}>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
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
  const [over, setOver] = useState<string | null>(null);
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
      if (stage === "final_check") toast.success(`Final check started on ${card.owner}/${card.repo}#${card.number}: a fresh reviewer, then a verifier`);
      if (stage === "fixing" || stage === "deslop") toast.success(`The author's agent is ${stage === "deslop" ? "deslopping" : "fixing"} ${card.owner}/${card.repo}#${card.number}; its thread is #${card.number} · ${stage === "deslop" ? "Deslop" : "Fixing"}`);
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
    const empty = () => Object.fromEntries(BOARD_STAGES.map((stage) => [stage, [] as ReviewSummary[]])) as Record<BoardStage, ReviewSummary[]>;
    const byLane: Record<BoardLane, Record<BoardStage, ReviewSummary[]>> = { mine: empty(), reviewing: empty() };
    const closed: ReviewSummary[] = [];
    for (const r of reviews ?? []) {
      const stage = moves[r.id] ?? r.stage;
      if (stage === null) closed.push(r);
      else byLane[r.mine ? "mine" : "reviewing"][stage].push(r);
    }
    for (const lane of BOARD_LANES) for (const stage of BOARD_STAGES) byLane[lane.id][stage].sort((a, b) => cardTime(b) - cardTime(a));
    closed.sort((a, b) => cardTime(b) - cardTime(a));
    return { byLane, closed };
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
          <div className="space-y-2 pb-2">
            {BOARD_LANES.map((lane) => {
              const cards = columns.byLane[lane.id];
              const total = BOARD_STAGES.reduce((n, stage) => n + cards[stage].length, 0);
              // My PRs shows once you have one there; Reviewing is always on the board.
              if (lane.id === "mine" && total === 0) return null;
              // Columns a PR rarely sits in show only when one does.
              const stages = lane.stages.filter((stage) => cards[stage].length > 0 || (stage !== "unreviewed" && stage !== "changes_requested"));
              return (
                <section key={lane.id} aria-label={lane.label}>
                  <h2 className="px-4 pt-3 text-xs font-semibold text-muted-foreground">{lane.label} <span className="font-normal tabular-nums">{total}</span></h2>
                  <div className="grid gap-3 px-4 pt-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                    {stages.map((stage) => {
                      const key = `${lane.id}:${stage}`;
                      return (
                        <BoardColumn
                          key={key}
                          stage={stage}
                          label={stageLabel(stage, lane.id)}
                          count={cards[stage].length}
                          over={over === key}
                          onOver={() => setOver(key)}
                          onLeave={() => setOver((s) => (s === key ? null : s))}
                          onDrop={(id) => {
                            setOver(null);
                            const card = reviews.find((r) => r.id === id);
                            if (card !== undefined) void move(card, stage);
                          }}
                        >
                          {cards[stage].map((card) => (
                            <PrCard key={card.id} card={card} stage={stage} onOpen={() => onOpen(card.id)} onRemove={() => void remove(card)} />
                          ))}
                        </BoardColumn>
                      );
                    })}
                  </div>
                </section>
              );
            })}
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
