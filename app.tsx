// bb-plugin-roundtable — frontend entry.
//
// One nav panel ("Roundtable") with a room list, the shared transcript, and a
// composer that tags participants or starts rounds. A fixed side-panel tab
// renders bb's own ThreadChat for whichever participant thread was clicked, so
// tool calls and diffs behind a reply stay one click away.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
  experimental_useAppPanel as useAppPanel,
  experimental_useFixedTabTarget as useFixedTabTarget,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import type {
  ContextOptions,
  Message,
  Participant,
  ParticipantInput,
  RoomDetail,
  RoomSummary,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;

const PANEL_ID = "rooms";
const PANEL_PATH = "rooms";
const ROOM_CHANGED = "room-changed";

interface AgentTabTarget {
  threadId: string;
  [key: string]: JsonValue;
}
function isAgentTabTarget(value: JsonValue): value is AgentTabTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { threadId?: unknown }).threadId === "string"
  );
}
const AGENT_TAB: ExperimentalPluginFixedTabReference<AgentTabTarget> = {
  panelId: PANEL_ID,
  id: "agent-thread",
  experimental_target: { validate: isAgentTabTarget },
};

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function roomIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as { roomId?: unknown }).roomId;
  return typeof id === "string" ? id : null;
}

function useRooms() {
  const rpc = useRpc<Contract>();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("rooms_list").then(
      (result) => {
        setRooms(result.rooms);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ROOM_CHANGED, refetch);
  return { rooms, error, refetch };
}

function useRoom(roomId: string | null) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (roomId === null) return;
    rpc.call("rooms_get", { roomId }).then(
      (result) => {
        setDetail(result);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, roomId]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    refetch();
  }, [refetch]);
  useRealtime(ROOM_CHANGED, (payload) => {
    const changed = roomIdOf(payload);
    if (changed === null || changed === roomId) refetch();
  });
  // Status changes inside a participant thread are not all published; poll
  // slowly while anything is running so the busy dots stay honest.
  const busy = detail?.participants.some((p) => p.status === "active" || p.status === "starting") || detail?.rounds !== null;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refetch, 4000);
    return () => clearInterval(timer);
  }, [busy, refetch]);
  return { rpc, detail, error, refetch };
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: string | null }) {
  const running = status === "active" || status === "starting" || status === "pending";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        running && "animate-pulse bg-primary",
        status === "error" && "bg-destructive",
        !running && status !== "error" && "bg-muted-foreground/40",
      )}
    />
  );
}

function ParticipantChip({
  participant,
  selected,
  onToggle,
  onOpen,
}: {
  participant: Participant;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <span className="inline-flex items-stretch overflow-hidden rounded-full border border-border text-xs">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onToggle}
        title={selected ? "Untag" : "Tag in next message"}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 hover:bg-state-hover",
          selected && "bg-foreground text-background hover:bg-foreground/90",
        )}
      >
        <StatusDot status={participant.status} />
        <span className="font-medium">@{participant.handle}</span>
        <span className={cn("text-muted-foreground", selected && "text-background/70")}>
          {participant.providerId}
          {participant.model ? ` · ${participant.model}` : ""}
        </span>
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={participant.threadId === null}
        title={participant.threadId === null ? "No thread yet (tag them first)" : "Open agent thread"}
        aria-label={`Open @${participant.handle} thread`}
        className="inline-flex items-center border-l border-border px-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
      >
        <Icon name="PanelRight" className="size-3.5" />
      </button>
    </span>
  );
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageRow({ message, providerOf }: { message: Message; providerOf: (handle: string) => string | null }) {
  const isUser = message.author === "user";
  const isSystem = message.author === "system";
  if (isSystem) {
    return (
      <li className="py-1 text-center text-xs text-muted-foreground">
        {message.text}
      </li>
    );
  }
  const provider = providerOf(message.author);
  return (
    <li className={cn("flex flex-col gap-1 py-3", isUser && "items-end")}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-foreground">{isUser ? "you" : `@${message.author}`}</span>
        {provider ? <span className="text-muted-foreground">{provider}</span> : null}
        {message.tags.length > 0 ? (
          <span className="text-muted-foreground">to {message.tags.map((t) => `@${t}`).join(", ")}</span>
        ) : null}
        <span className="text-muted-foreground">#{message.seq} · {timeLabel(message.createdAt)}</span>
      </div>
      <div
        className={cn(
          "max-w-[85%] rounded-lg border border-border px-3.5 py-2.5 text-sm",
          isUser ? "bg-foreground/5" : "bg-card",
        )}
      >
        <Markdown content={message.text} />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Room view
// ---------------------------------------------------------------------------

function parseMentions(text: string, handles: readonly string[]): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[^a-z0-9])@([a-z][a-z0-9-]*)/gi)) {
    const handle = match[2].toLowerCase();
    if (handles.includes(handle)) found.add(handle);
  }
  return [...found];
}

function RoomView({ roomId }: { roomId: string }) {
  const { rpc, detail, error, refetch } = useRoom(roomId);
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const [text, setText] = useState("");
  const [tagged, setTagged] = useState<string[]>([]);
  const [roundCount, setRoundCount] = useState(3);
  const [pendingAction, setPendingAction] = useState<"send" | "rounds" | "cancel" | "archive" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const handles = useMemo(() => detail?.participants.map((p) => p.handle) ?? [], [detail]);
  const mentioned = useMemo(() => parseMentions(text, handles), [text, handles]);
  const tags = useMemo(() => [...new Set([...tagged, ...mentioned])], [tagged, mentioned]);
  const providerOf = useCallback(
    (handle: string) => detail?.participants.find((p) => p.handle === handle)?.providerId ?? null,
    [detail],
  );

  const messageCount = detail?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount, detail?.rounds?.current]);

  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const run = async (action: NonNullable<typeof pendingAction>, fn: () => Promise<unknown>) => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await fn();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const send = () =>
    run("send", async () => {
      const body = text.trim();
      if (body === "") return;
      await rpc.call("rooms_post", { roomId, text: body, tags });
      setText("");
      setTagged([]);
      stickToBottom.current = true;
      refetch();
    });

  const startRounds = () =>
    run("rounds", async () => {
      const body = text.trim();
      if (body === "" || tags.length < 2) return;
      await rpc.call("rooms_start_rounds", { roomId, text: body, participants: tags, rounds: roundCount });
      setText("");
      setTagged([]);
      stickToBottom.current = true;
      refetch();
    });

  const cancelRounds = () => run("cancel", () => rpc.call("rooms_cancel_rounds", { roomId }));

  const archive = () =>
    run("archive", async () => {
      if (!window.confirm("Archive this room and stop its participant threads?")) return;
      await rpc.call("rooms_archive", { roomId });
      navigate.toPluginPanel(PANEL_PATH, { replace: true });
    });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const openThread = (participant: Participant) => {
    if (participant.threadId === null) return;
    const accepted = panel.openFixedTab({
      surface: { kind: "current" },
      tab: AGENT_TAB,
      target: { threadId: participant.threadId },
    });
    if (!accepted) navigate.toThread(participant.threadId);
  };

  if (error !== null) {
    return (
      <div className="p-4">
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="p-4">
        <EmptyState>Loading room…</EmptyState>
      </div>
    );
  }

  const rounds = detail.rounds;
  const canSend = text.trim() !== "" && pendingAction === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{detail.room.title}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {detail.workspacePath ?? "Workspace resolves when the first participant is tagged"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={archive} disabled={pendingAction !== null} aria-label="Archive room">
          <Icon name="Archive" className="size-4" />
          Archive
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {detail.participants.map((participant) => (
          <ParticipantChip
            key={participant.handle}
            participant={participant}
            selected={tags.includes(participant.handle)}
            onToggle={() =>
              setTagged((current) =>
                current.includes(participant.handle)
                  ? current.filter((h) => h !== participant.handle)
                  : [...current, participant.handle],
              )
            }
            onOpen={() => openThread(participant)}
          />
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          Click a name to tag it. Type @handle to tag inline.
        </span>
      </div>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4">
        {detail.messages.length === 0 ? (
          <div className="py-6">
            <EmptyState>
              Empty room. Tag a participant and say something, for example{" "}
              <code>@{handles[0] ?? "claude"} draft a plan for …</code>
            </EmptyState>
          </div>
        ) : (
          <ul className="mx-auto w-full max-w-3xl divide-y divide-border/60">
            {detail.messages.map((message) => (
              <MessageRow key={message.seq} message={message} providerOf={providerOf} />
            ))}
          </ul>
        )}
      </div>

      {rounds !== null ? (
        <div className="flex items-center gap-3 border-t border-border bg-card px-4 py-2 text-xs">
          <Icon name="Loading" className="size-3.5 animate-spin text-muted-foreground" />
          <span>
            Round {Math.max(rounds.round, 1)} of {rounds.total} · {rounds.participants.map((h) => `@${h}`).join(" -> ")}
            {rounds.current ? ` · @${rounds.current} is responding` : ""}
          </span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={cancelRounds} disabled={pendingAction !== null}>
            <Icon name="Square" className="size-3.5" />
            Cancel rounds
          </Button>
        </div>
      ) : null}

      <form
        className="border-t border-border px-4 py-3"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={
            tags.length === 0
              ? "Post a note to the room, or tag someone with @handle to get a reply…"
              : `Message to ${tags.map((t) => `@${t}`).join(", ")}…`
          }
          aria-label="Message"
          className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {tags.length === 0
              ? "No one tagged: posts a note only."
              : `Tagged: ${tags.map((t) => `@${t}`).join(", ")}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Rounds
              <Input
                type="number"
                min={1}
                max={20}
                value={roundCount}
                onChange={(event) => setRoundCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
                className="h-8 w-16 text-xs"
                aria-label="Number of rounds"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startRounds}
              disabled={!canSend || tags.length < 2 || rounds !== null}
              aria-label={tags.length < 2 ? "Tag at least two participants to run rounds" : "Kick off rounds between the tagged participants"}
            >
              <Icon name="Repeat" className="size-3.5" />
              Start rounds
            </Button>
            <Button type="submit" size="sm" disabled={!canSend}>
              <Icon name="Sent" className="size-3.5" />
              Send
            </Button>
          </div>
        </div>
        {actionError !== null ? (
          <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p>
        ) : null}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create room
// ---------------------------------------------------------------------------

interface DraftParticipant {
  key: number;
  handle: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
}

function defaultDrafts(options: ContextOptions): DraftParticipant[] {
  const available = options.providers.filter((p) => p.available);
  const has = (id: string) => available.some((p) => p.id === id);
  const drafts: DraftParticipant[] = [];
  let key = 1;
  if (has("claude-code")) drafts.push({ key: key++, handle: "claude", providerId: "claude-code", model: "", reasoningLevel: "" });
  if (has("codex")) drafts.push({ key: key++, handle: "codex", providerId: "codex", model: "", reasoningLevel: "" });
  const acp = available.find((p) => p.id.startsWith("acp-") && p.models.length > 0) ?? available.find((p) => p.id.startsWith("acp-"));
  if (acp) drafts.push({ key: key++, handle: acp.id.replace(/^acp-/, ""), providerId: acp.id, model: "", reasoningLevel: "" });
  if (drafts.length === 0 && available[0]) {
    drafts.push({ key: key++, handle: available[0].id.replace(/[^a-z0-9-]/g, ""), providerId: available[0].id, model: "", reasoningLevel: "" });
  }
  return drafts;
}

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function CreateRoomForm() {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [drafts, setDrafts] = useState<DraftParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nextKey = useRef(100);

  useEffect(() => {
    rpc.call("context_options").then(
      (result) => {
        setOptions(result);
        setDrafts(defaultDrafts(result));
        const personal = result.projects.find((p) => p.kind !== "standard");
        setProjectId((current) => current || personal?.id || result.projects[0]?.id || "");
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);

  const update = (key: number, patch: Partial<DraftParticipant>) =>
    setDrafts((current) => current.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || options === null) return;
    setPending(true);
    setError(null);
    try {
      const participants: ParticipantInput[] = drafts.map((d) => ({
        handle: d.handle.trim().toLowerCase(),
        providerId: d.providerId,
        ...(d.model ? { model: d.model } : {}),
        ...(d.reasoningLevel ? { reasoningLevel: d.reasoningLevel as ParticipantInput["reasoningLevel"] } : {}),
      }));
      const { room } = await rpc.call("rooms_create", { title: title.trim(), projectId, participants });
      navigate.toPluginPanel(PANEL_PATH, { subPath: room.id, replace: true });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };

  if (options === null) {
    return (
      <div className="p-4">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <EmptyState>Loading providers…</EmptyState>}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <form onSubmit={submit} className="mx-auto w-full max-w-3xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold">New room</h2>
          <p className="text-xs text-muted-foreground">
            Every participant gets its own thread in one shared workspace. Threads are created the first time each participant is tagged.
          </p>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Title
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Plan review: session indexer" required />
        </label>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={cn(selectClass, "block h-9 w-full")}>
            {options.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}{project.kind !== "standard" ? " (personal)" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Participants</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const first = options.providers.find((p) => p.available) ?? options.providers[0];
                if (!first) return;
                setDrafts((current) => [
                  ...current,
                  { key: nextKey.current++, handle: "", providerId: first.id, model: "", reasoningLevel: "" },
                ]);
              }}
            >
              <Icon name="Plus" className="size-4" />
              Add
            </Button>
          </div>
          <ul className="space-y-2">
            {drafts.map((draft) => {
              const provider = options.providers.find((p) => p.id === draft.providerId);
              return (
                <li key={draft.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
                  <span className="text-xs text-muted-foreground">@</span>
                  <Input
                    value={draft.handle}
                    onChange={(event) => update(draft.key, { handle: event.target.value })}
                    placeholder="handle"
                    pattern="[a-z][a-z0-9-]{0,23}"
                    title="lowercase letters, digits, dashes"
                    required
                    className="h-8 w-28 text-xs"
                    aria-label="Handle"
                  />
                  <select
                    value={draft.providerId}
                    onChange={(event) => update(draft.key, { providerId: event.target.value, model: "", reasoningLevel: "" })}
                    className={selectClass}
                    aria-label="Provider"
                  >
                    {options.providers.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.available}>
                        {p.displayName}{p.available ? "" : " (unavailable)"}
                      </option>
                    ))}
                  </select>
                  <select
                    value={draft.model}
                    onChange={(event) => update(draft.key, { model: event.target.value })}
                    className={selectClass}
                    aria-label="Model"
                  >
                    <option value="">default model</option>
                    {(provider?.models ?? []).map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.displayName}{m.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                  {(provider?.reasoningLevels.length ?? 0) > 0 ? (
                    <select
                      value={draft.reasoningLevel}
                      onChange={(event) => update(draft.key, { reasoningLevel: event.target.value })}
                      className={selectClass}
                      aria-label="Reasoning"
                    >
                      <option value="">default reasoning</option>
                      {provider!.reasoningLevels
                        .filter((level) => ["low", "medium", "high", "xhigh", "max"].includes(level))
                        .map((level) => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                    </select>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-auto size-7 text-muted-foreground hover:text-foreground"
                    aria-label="Remove participant"
                    onClick={() => setDrafts((current) => current.filter((d) => d.key !== draft.key))}
                  >
                    <Icon name="Trash2" className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || drafts.length === 0 || title.trim() === "" || projectId === ""}>
            <Icon name="MessageSquarePlus" className="size-4" />
            Create room
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate.toPluginPanel(PANEL_PATH, { replace: true })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function RoomListItem({ room, active, onSelect }: { room: RoomSummary; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn(
          "w-full rounded-md px-2.5 py-2 text-left hover:bg-state-hover",
          active && "bg-state-active",
        )}
      >
        <div className="truncate text-sm font-medium">{room.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {room.handles.map((h) => `@${h}`).join(" ")} · {room.messageCount} msg
          {room.lastAuthor ? ` · last ${room.lastAuthor === "user" ? "you" : `@${room.lastAuthor}`}` : ""}
        </div>
      </button>
    </li>
  );
}

function RoundtablePage({ subPath }: { subPath: string }) {
  const { rooms, error } = useRooms();
  const navigate = useBbNavigate();
  const [head] = subPath.split("/");
  const creating = head === "new";
  const roomId = !creating && head !== "" ? head : null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs font-medium text-muted-foreground">Rooms</span>
          <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "new" })}>
            <Icon name="Plus" className="size-4" />
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {error ? (
            <p role="alert" className="px-2 text-xs text-destructive">{error}</p>
          ) : rooms === null ? (
            <p className="px-2 text-xs text-muted-foreground">Loading…</p>
          ) : rooms.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No rooms yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {rooms.map((room) => (
                <RoomListItem
                  key={room.id}
                  room={room}
                  active={room.id === roomId}
                  onSelect={() => navigate.toPluginPanel(PANEL_PATH, { subPath: room.id })}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {creating ? (
          <CreateRoomForm />
        ) : roomId !== null ? (
          <RoomView key={roomId} roomId={roomId} />
        ) : (
          <div className="p-6">
            <EmptyState>
              Pick a room or create one. Each room is a shared transcript where you tag agents in, and
              they can be sent back and forth for a bounded number of rounds.
            </EmptyState>
          </div>
        )}
      </main>
    </div>
  );
}

function AgentThreadTab() {
  const target = useFixedTabTarget(AGENT_TAB);
  if (target === null) {
    return (
      <div className="p-4">
        <EmptyState>Click the panel icon next to a participant to open its thread here.</EmptyState>
      </div>
    );
  }
  return (
    <ThreadChat
      key={target.target.threadId}
      threadId={target.target.threadId}
      variant="compact"
      layout="contained"
      className="h-full"
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Roundtable",
    icon: "MessageSquare",
    path: PANEL_PATH,
    component: RoundtablePage,
    fixedTabs: [
      {
        ...AGENT_TAB,
        title: "Agent thread",
        icon: "Bot",
        layout: "flush",
        component: AgentThreadTab,
      },
    ],
  });
});
