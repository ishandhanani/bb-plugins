// The PR threads panel: the factory's threads, one folder per PR under its
// repository, kept out of the main sidebar. A PR that needs you, or has a
// thread working, opens expanded and sorts first.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PrThreads, rpcContract } from "./server";
import { isBoardStage, stageLabel } from "./board-spec";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { describeError, timeAgo } from "@/lib/format";

const REVIEW_CHANGED = "review-changed";
const WORKING = new Set(["active", "pending", "starting", "stopping"]);

function usePrThreads() {
  const rpc = useRpc<typeof rpcContract>();
  const [prs, setPrs] = useState<PrThreads[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("pr_threads", null).then((r) => { setPrs(r.prs); setError(null); }, (cause: unknown) => setError(describeError(cause)));
  }, [rpc]);
  useEffect(() => {
    load();
    // Thread status (working, unread) changes without a factory event.
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(REVIEW_CHANGED, load);
  return { prs, error };
}

const busy = (pr: PrThreads) => pr.threads.some((t) => WORKING.has(t.status));
const latest = (pr: PrThreads) => Math.max(...pr.threads.map((t) => t.updatedAt));

export function PrThreadsPage({ onOpenPr }: { onOpenPr: (reviewId: string) => void }) {
  const { prs, error } = usePrThreads();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const repos = useMemo(() => {
    const byRepo = new Map<string, PrThreads[]>();
    for (const pr of prs ?? []) byRepo.set(`${pr.owner}/${pr.repo}`, [...(byRepo.get(`${pr.owner}/${pr.repo}`) ?? []), pr]);
    const rank = (pr: PrThreads) => (pr.needsYou ? 0 : busy(pr) ? 1 : 2);
    for (const list of byRepo.values()) list.sort((a, b) => rank(a) - rank(b) || latest(b) - latest(a));
    return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [prs]);

  if (error !== null) return <p role="alert" className="p-6 text-sm text-destructive">{error}</p>;
  if (prs === null) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (prs.length === 0) return <p className="p-6 text-sm text-muted-foreground">No PR in the factory has threads yet.</p>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
        {repos.map(([repo, list]) => (
          <section key={repo} aria-label={repo}>
            <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Icon name="FolderOpen" className="size-3.5" />{repo}
            </h2>
            <ul className="space-y-1">
              {list.map((pr) => {
                const expanded = open[pr.reviewId] ?? (pr.needsYou !== null || busy(pr));
                const unread = pr.threads.some((t) => t.unread);
                return (
                  <li key={pr.reviewId} className="rounded-md border border-border bg-card">
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [pr.reviewId]: !expanded }))}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-state-hover"
                    >
                      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 tabular-nums text-muted-foreground">#{pr.number}</span>
                      <span className={cn("min-w-0 flex-1 truncate", unread && "font-medium")}>{pr.title}</span>
                      {pr.needsYou !== null ? <span title={pr.needsYou} className="shrink-0 rounded border border-destructive/40 px-1.5 text-[11px] text-destructive">Needs you</span>
                        : busy(pr) ? <Icon name="Loading" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        : pr.stage !== null && isBoardStage(pr.stage) ? <span className="shrink-0 text-[11px] text-muted-foreground">{stageLabel(pr.stage, pr.mine ? "mine" : "reviewing")}</span> : null}
                    </button>
                    {expanded ? (
                      <ul className="border-t border-border py-1">
                        {pr.threads.map((t) => (
                          <li key={t.id}>
                            <button type="button" onClick={() => navigate.toThread(t.id)} className="flex w-full items-center gap-2 py-1 pl-8 pr-2.5 text-left text-xs hover:bg-state-hover">
                              <span className={cn("size-1.5 shrink-0 rounded-full", t.status === "error" ? "bg-destructive" : WORKING.has(t.status) ? "animate-pulse bg-primary" : t.unread ? "bg-foreground" : "bg-transparent")} />
                              <span className={cn("min-w-0 flex-1 truncate", t.unread && "font-medium")}>{t.label}</span>
                              <span className="shrink-0 text-muted-foreground">{WORKING.has(t.status) ? "working" : timeAgo(t.updatedAt)}</span>
                            </button>
                          </li>
                        ))}
                        <li>
                          <button type="button" onClick={() => onOpenPr(pr.reviewId)} className="flex w-full items-center gap-2 py-1 pl-8 pr-2.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
                            <Icon name="GitPullRequest" className="size-3" />Open the PR page
                          </button>
                        </li>
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
