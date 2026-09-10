// bb-plugin-roundtable — frontend entry.
//
// One nav panel ("Roundtable") with a room list, the shared transcript, and a
// composer that tags participants, starts rounds, or asks everyone. Fixed side
// tabs render bb's own ThreadChat for a participant thread and the room's
// pinned document. A thread panel action opens (or creates) the room bound to
// the current thread's workspace.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
  experimental_FileLink as FileLink,
  experimental_SourceCode as SourceCode,
  experimental_useAppPanel as useAppPanel,
  experimental_useFixedTabTarget as useFixedTabTarget,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import type {
  Brief,
  ChangedFile,
  ContextOptions,
  DocRead,
  Job,
  Message,
  Participant,
  ParticipantInput,
  Role,
  RoomDetail,
  RoomSummary,
  Stance,
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

const ROLE_OPTIONS: readonly Role[] = ["none", "planner", "reviewer", "implementer", "custom"];
const ROLE_HINTS: Record<Role, string> = {
  none: "No role contract",
  planner: "Owns the proposal; numbered decisions; answers findings by number",
  reviewer: "Numbered findings with severity, target, why, fix",
  implementer: "Edits only when asked; lists files first; reports verification",
  custom: "Your own instructions",
};

interface AgentTabTarget {
  threadId: string;
  [key: string]: JsonValue;
}
interface DocTabTarget {
  roomId: string;
  [key: string]: JsonValue;
}
function hasStringField(value: JsonValue, field: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[field] === "string"
  );
}
const AGENT_TAB: ExperimentalPluginFixedTabReference<AgentTabTarget> = {
  panelId: PANEL_ID,
  id: "agent-thread",
  experimental_target: { validate: (value): value is AgentTabTarget => hasStringField(value, "threadId") },
};
const DOC_TAB: ExperimentalPluginFixedTabReference<DocTabTarget> = {
  panelId: PANEL_ID,
  id: "document",
  experimental_target: { validate: (value): value is DocTabTarget => hasStringField(value, "roomId") },
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
  const busy =
    detail?.participants.some((p) => !p.removed && (p.status === "active" || p.status === "starting")) ||
    (detail?.job !== null && detail?.job !== undefined);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refetch, 4000);
    return () => clearInterval(timer);
  }, [busy, refetch]);
  return { rpc, detail, error, refetch };
}

function useChanges(roomId: string, enabled: boolean) {
  const rpc = useRpc<Contract>();
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (!enabled) return;
    rpc.call("rooms_changes", { roomId }).then(
      (result) => {
        setFiles(result.files);
        setNote(result.note);
      },
      (cause: unknown) => setNote(describeError(cause)),
    );
  }, [rpc, roomId, enabled]);
  useEffect(() => {
    refetch();
    if (!enabled) return;
    const timer = setInterval(refetch, 10_000);
    return () => clearInterval(timer);
  }, [refetch, enabled]);
  useRealtime(ROOM_CHANGED, (payload) => {
    const changed = roomIdOf(payload);
    if (changed === null || changed === roomId) refetch();
  });
  return { files, note };
}

function useDoc(roomId: string | null) {
  const rpc = useRpc<Contract>();
  const [doc, setDoc] = useState<DocRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (roomId === null) return;
    rpc.call("rooms_doc_read", { roomId }).then(
      (result) => {
        setDoc(result);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, roomId]);
  useEffect(refetch, [refetch]);
  useRealtime(ROOM_CHANGED, (payload) => {
    const changed = roomIdOf(payload);
    if (changed === null || changed === roomId) refetch();
  });
  return { rpc, doc, error, refetch };
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

const STANCE_STYLE: Record<Stance, string> = {
  agree: "border-foreground/30 text-foreground",
  disagree: "border-destructive/50 text-destructive",
  "need-info": "border-foreground/40 bg-foreground/10 text-foreground",
  pass: "border-border text-muted-foreground",
};
const STANCE_ICON: Record<Stance, "Check" | "CircleX" | "CircleQuestion" | "ArrowRight"> = {
  agree: "Check",
  disagree: "CircleX",
  "need-info": "CircleQuestion",
  pass: "ArrowRight",
};

function StanceBadge({ stance, small }: { stance: Stance; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        small ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]",
        STANCE_STYLE[stance],
      )}
      title={`Stance: ${stance}`}
    >
      <Icon name={STANCE_ICON[stance]} className={small ? "size-2.5" : "size-3"} />
      {stance}
    </span>
  );
}

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function durationLabel(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

interface ParticipantChipProps {
  participant: Participant;
  selected: boolean;
  isDocOwner: boolean;
  canSummarize: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onCompact: () => void;
  onReset: (brief: Brief) => void;
  onRemove: () => void;
}

function ParticipantChip({ participant, selected, isDocOwner, canSummarize, onToggle, onOpen, onCompact, onReset, onRemove }: ParticipantChipProps) {
  const [menu, setMenu] = useState(false);
  const stats = `${participant.turns} turn${participant.turns === 1 ? "" : "s"} · ~${formatChars(participant.relayedChars)} chars relayed${participant.role !== "none" ? ` · ${participant.role}` : ""}`;
  return (
    <span className="relative inline-flex items-stretch overflow-visible rounded-full border border-border text-xs">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onToggle}
        title={`${selected ? "Untag" : "Tag in next message"} · ${stats}`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-l-full px-2.5 py-1 hover:bg-state-hover",
          selected && "bg-foreground text-background hover:bg-foreground/90",
        )}
      >
        <StatusDot status={participant.status} />
        <span className="font-medium">@{participant.handle}</span>
        <span className={cn("text-muted-foreground", selected && "text-background/70")}>
          {participant.role !== "none" ? participant.role : participant.providerId}
        </span>
        {isDocOwner ? <Icon name="FileText" className={cn("size-3 text-muted-foreground", selected && "text-background/70")} aria-label="Document owner" /> : null}
        {participant.lastStance ? <StanceBadge stance={participant.lastStance} small /> : null}
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
      <button
        type="button"
        onClick={() => setMenu((open) => !open)}
        aria-label={`More actions for @${participant.handle}`}
        aria-expanded={menu}
        className="inline-flex items-center rounded-r-full border-l border-border px-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
      >
        <Icon name="MoreHorizontal" className="size-3.5" />
      </button>
      {menu ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-border bg-card p-1 text-xs shadow-md">
          <p className="px-2 py-1 text-muted-foreground">{stats}</p>
          <p className="px-2 pb-1 text-muted-foreground">
            {participant.providerId}
            {participant.model ? ` · ${participant.model}` : ""}
            {participant.reasoningLevel ? ` · ${participant.reasoningLevel}` : ""}
          </p>
          <MenuItem icon="Layers" label="Compact context" disabled={participant.threadId === null} onClick={() => { setMenu(false); onCompact(); }} />
          <MenuItem icon="RotateCcw" label="Reset with summary" disabled={!canSummarize} onClick={() => { setMenu(false); onReset("summary"); }} />
          <MenuItem icon="RotateCcw" label="Reset with full history" onClick={() => { setMenu(false); onReset("full"); }} />
          <MenuItem icon="Trash2" label="Remove from room" destructive onClick={() => { setMenu(false); onRemove(); }} />
        </div>
      ) : null}
    </span>
  );
}

function MenuItem({ icon, label, onClick, disabled, destructive }: { icon: "Layers" | "RotateCcw" | "Trash2"; label: string; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover disabled:opacity-40",
        destructive && "text-destructive",
      )}
    >
      <Icon name={icon} className="size-3.5" />
      {label}
    </button>
  );
}

function MessageRow({ message, providerOf }: { message: Message; providerOf: (handle: string) => string | null }) {
  const isUser = message.author === "user";
  if (message.author === "system") {
    return <li className="py-1.5 text-center text-xs text-muted-foreground">{message.text}</li>;
  }
  const provider = providerOf(message.author);
  return (
    <li className={cn("flex flex-col gap-1 py-3", isUser && "items-end")} id={`msg-${message.seq}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground">{isUser ? "you" : `@${message.author}`}</span>
        {provider ? <span className="text-muted-foreground">{provider}</span> : null}
        {message.tags.length > 0 ? (
          <span className="text-muted-foreground">to {message.tags.map((t) => `@${t}`).join(", ")}</span>
        ) : null}
        {message.stance ? <StanceBadge stance={message.stance} /> : null}
        {message.hopsLeft > 0 ? (
          <span className="text-muted-foreground" title="Agent-to-agent hops this message may still trigger">
            hops {message.hopsLeft}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          #{message.seq} · {timeLabel(message.createdAt)}
          {message.durationMs !== null ? ` · ${durationLabel(message.durationMs)}` : ""}
        </span>
      </div>
      <div className={cn("max-w-[85%] rounded-lg border border-border px-3.5 py-2.5 text-sm", isUser ? "bg-foreground/5" : "bg-card")}>
        <Markdown content={message.body} />
        {message.openPoints.length > 0 ? (
          <div className="mt-2 border-t border-border pt-2 text-xs">
            <span className="font-medium text-muted-foreground">Open</span>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {message.openPoints.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function JobBanner({ job, onCancel, onResume, disabled }: { job: NonNullable<Job>; onCancel: () => void; onResume: () => void; disabled: boolean }) {
  const roster = job.participants.map((h) => `@${h}`).join(", ");
  let text: string;
  if (job.paused) {
    text = `Paused. @${job.paused.handle} needs input: ${job.paused.question}`;
  } else if (job.kind === "rounds") {
    const perRound = job.participants.length;
    const round = Math.max(1, Math.ceil(Math.max(job.turn, 1) / perRound));
    text = `Rounds · turn ${job.turn}/${job.totalTurns} (round ${round}) · ${roster}${job.current ? ` · @${job.current} is responding` : ""}`;
  } else {
    const waiting = job.inFlight.map((h) => `@${h}`).join(", ");
    text = `Asking ${roster}${waiting ? ` · waiting on ${waiting}` : ""}${job.synthesizer ? ` · then @${job.synthesizer} synthesizes` : ""}`;
  }
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-2 text-xs">
      {job.paused ? (
        <Icon name="Pause" className="size-3.5 text-muted-foreground" />
      ) : (
        <Icon name="Loading" className="size-3.5 animate-spin text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">{text}</span>
      {job.paused ? (
        <Button variant="outline" size="sm" onClick={onResume} disabled={disabled}>
          <Icon name="Play" className="size-3.5" />
          Resume
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
        <Icon name="Square" className="size-3.5" />
        Cancel
      </Button>
    </div>
  );
}

function ChangesBar({ roomId, environmentId }: { roomId: string; environmentId: string | null }) {
  const { files, note } = useChanges(roomId, environmentId !== null);
  const [open, setOpen] = useState(false);
  if (environmentId === null) return null;
  const total = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  return (
    <div className="border-b border-border px-4 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <Icon name="FileDiff" className="size-3.5" />
        {files.length === 0
          ? note ?? "Workspace clean: no uncommitted changes"
          : `${files.length} file${files.length === 1 ? "" : "s"} changed in the workspace (${total} lines)`}
        {files.length > 0 ? <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3" /> : null}
      </button>
      {open && files.length > 0 ? (
        <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
          {files.map((file) => (
            <li key={file.path} className="flex items-center gap-2 font-mono">
              <FileLink target={{ kind: "workspace", environmentId, path: file.path }} className="truncate hover:underline">
                {file.path}
              </FileLink>
              <span className="text-muted-foreground">
                {file.changeKind} +{file.additions} -{file.deletions}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room settings and add-participant forms
// ---------------------------------------------------------------------------

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function RoomSettings({ detail, onDone }: { detail: RoomDetail; onDone: () => void }) {
  const rpc = useRpc<Contract>();
  const [title, setTitle] = useState(detail.room.title);
  const [docPath, setDocPath] = useState(detail.room.docPath ?? "");
  const [docOwner, setDocOwner] = useState(detail.room.docOwner ?? "");
  const [hops, setHops] = useState(detail.room.defaultHops);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const handles = detail.participants.filter((p) => !p.removed).map((p) => p.handle);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await rpc.call("rooms_update", {
        roomId: detail.room.id,
        title: title.trim(),
        docPath: docPath.trim() === "" ? null : docPath.trim(),
        docOwner: docOwner === "" ? null : docOwner,
        defaultHops: hops,
      });
      onDone();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border-b border-border bg-card px-4 py-2 text-xs">
      <label className="flex flex-col gap-1 text-muted-foreground">
        Title
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 w-56 text-xs" required />
      </label>
      <label className="flex flex-col gap-1 text-muted-foreground">
        Pinned document (workspace path)
        <Input value={docPath} onChange={(e) => setDocPath(e.target.value)} placeholder=".roundtable/plan.md" className="h-8 w-56 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-muted-foreground">
        Document owner
        <select value={docOwner} onChange={(e) => setDocOwner(e.target.value)} className={selectClass} disabled={docPath.trim() === ""}>
          <option value="">you</option>
          {handles.map((h) => (
            <option key={h} value={h}>@{h}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-muted-foreground">
        Default hops
        <Input type="number" min={0} max={8} value={hops} onChange={(e) => setHops(Math.min(8, Math.max(0, Number(e.target.value) || 0)))} className="h-8 w-16 text-xs" />
      </label>
      <Button type="submit" size="sm" disabled={pending || title.trim() === ""}>Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      {error ? <span role="alert" className="text-destructive">{error}</span> : null}
    </form>
  );
}

interface SeatDraft {
  handle: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  role: Role;
  roleInstructions: string;
}

function toParticipantInput(seat: SeatDraft): ParticipantInput {
  return {
    handle: seat.handle.trim().toLowerCase(),
    providerId: seat.providerId,
    ...(seat.model ? { model: seat.model } : {}),
    ...(seat.reasoningLevel ? { reasoningLevel: seat.reasoningLevel as ParticipantInput["reasoningLevel"] } : {}),
    role: seat.role,
    roleInstructions: seat.role === "custom" ? seat.roleInstructions : null,
  };
}

function SeatEditor({ seat, options, onChange, onRemove }: { seat: SeatDraft; options: ContextOptions; onChange: (patch: Partial<SeatDraft>) => void; onRemove?: () => void }) {
  const provider = options.providers.find((p) => p.id === seat.providerId);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">@</span>
        <Input
          value={seat.handle}
          onChange={(e) => onChange({ handle: e.target.value })}
          placeholder="handle"
          pattern="[a-z][a-z0-9-]{0,23}"
          title="lowercase letters, digits, dashes"
          required
          className="h-8 w-28 text-xs"
          aria-label="Handle"
        />
        <select value={seat.providerId} onChange={(e) => onChange({ providerId: e.target.value, model: "", reasoningLevel: "" })} className={selectClass} aria-label="Provider">
          {options.providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.displayName}{p.available ? "" : " (unavailable)"}
            </option>
          ))}
        </select>
        <select value={seat.model} onChange={(e) => onChange({ model: e.target.value })} className={selectClass} aria-label="Model">
          <option value="">default model</option>
          {(provider?.models ?? []).map((m) => (
            <option key={m.model} value={m.model}>{m.displayName}{m.isDefault ? " (default)" : ""}</option>
          ))}
        </select>
        {(provider?.reasoningLevels.length ?? 0) > 0 ? (
          <select value={seat.reasoningLevel} onChange={(e) => onChange({ reasoningLevel: e.target.value })} className={selectClass} aria-label="Reasoning">
            <option value="">default reasoning</option>
            {(provider?.reasoningLevels ?? [])
              .filter((level) => ["low", "medium", "high", "xhigh", "max"].includes(level))
              .map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
          </select>
        ) : null}
        <select value={seat.role} onChange={(e) => onChange({ role: e.target.value as Role })} className={selectClass} aria-label="Role" title={ROLE_HINTS[seat.role]}>
          {ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>{role === "none" ? "no role" : role}</option>
          ))}
        </select>
        {onRemove ? (
          <Button type="button" variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground hover:text-foreground" aria-label="Remove seat" onClick={onRemove}>
            <Icon name="Trash2" className="size-4" />
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{ROLE_HINTS[seat.role]}</p>
      {seat.role === "custom" ? (
        <textarea
          value={seat.roleInstructions}
          onChange={(e) => onChange({ roleInstructions: e.target.value })}
          rows={2}
          placeholder="What this participant is responsible for and how it must reply"
          className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : null}
    </div>
  );
}

function AddParticipantForm({ detail, options, onDone }: { detail: RoomDetail; options: ContextOptions; onDone: () => void }) {
  const rpc = useRpc<Contract>();
  const first = options.providers.find((p) => p.available) ?? options.providers[0];
  const [seat, setSeat] = useState<SeatDraft>({ handle: "", providerId: first?.id ?? "", model: "", reasoningLevel: "", role: "none", roleInstructions: "" });
  const speakers = detail.participants.filter((p) => !p.removed && p.threadId !== null);
  const [brief, setBrief] = useState<Brief>(speakers.length > 0 ? "summary" : "full");
  const [summarizer, setSummarizer] = useState(speakers[0]?.handle ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await rpc.call("rooms_add_participant", {
        roomId: detail.room.id,
        participant: toParticipantInput(seat),
        brief,
        summarizer: brief === "summary" ? summarizer || null : null,
      });
      onDone();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 border-b border-border bg-card px-4 py-2 text-xs">
      <SeatEditor seat={seat} options={options} onChange={(patch) => setSeat((s) => ({ ...s, ...patch }))} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          Briefing
          <select value={brief} onChange={(e) => setBrief(e.target.value as Brief)} className={selectClass}>
            <option value="summary" disabled={speakers.length === 0}>summary written by a participant</option>
            <option value="full">full transcript</option>
            <option value="none">none, start from now</option>
          </select>
        </label>
        {brief === "summary" ? (
          <select value={summarizer} onChange={(e) => setSummarizer(e.target.value)} className={selectClass} aria-label="Summarizer">
            {speakers.map((p) => (
              <option key={p.handle} value={p.handle}>@{p.handle}</option>
            ))}
          </select>
        ) : null}
        <Button type="submit" size="sm" disabled={pending || seat.handle.trim() === ""}>
          <Icon name="UserRoundPlus" className="size-3.5" />
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        {error ? <span role="alert" className="text-destructive">{error}</span> : null}
      </div>
    </form>
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

type PendingAction = "send" | "rounds" | "askall" | "cancel" | "resume" | "archive" | "participant" | null;

function RoomView({ roomId, compact = false }: { roomId: string; compact?: boolean }) {
  const { rpc, detail, error, refetch } = useRoom(roomId);
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const [text, setText] = useState("");
  const [tagged, setTagged] = useState<string[]>([]);
  const [roundCount, setRoundCount] = useState(3);
  const [hops, setHops] = useState<number | null>(null);
  const [synthesizer, setSynthesizer] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const active = useMemo(() => detail?.participants.filter((p) => !p.removed) ?? [], [detail]);
  const handles = useMemo(() => active.map((p) => p.handle), [active]);
  const mentioned = useMemo(() => parseMentions(text, handles), [text, handles]);
  const tags = useMemo(() => [...new Set([...tagged, ...mentioned])], [tagged, mentioned]);
  const providerOf = useCallback(
    (handle: string) => detail?.participants.find((p) => p.handle === handle)?.providerId ?? null,
    [detail],
  );
  const effectiveHops = hops ?? detail?.room.defaultHops ?? 0;

  useEffect(() => {
    if (showAdd && options === null) {
      rpc.call("context_options").then(setOptions, (cause: unknown) => setActionError(describeError(cause)));
    }
  }, [showAdd, options, rpc]);

  const messageCount = detail?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el === null || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount, detail?.job?.current]);

  const onScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const run = async (action: NonNullable<PendingAction>, fn: () => Promise<unknown>) => {
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

  const afterSend = () => {
    setText("");
    setTagged([]);
    stickToBottom.current = true;
    refetch();
  };

  const send = () =>
    run("send", async () => {
      const body = text.trim();
      if (body === "") return;
      await rpc.call("rooms_post", { roomId, text: body, tags, hops: effectiveHops });
      afterSend();
    });

  const startRounds = () =>
    run("rounds", async () => {
      const body = text.trim();
      if (body === "" || tags.length < 2) return;
      await rpc.call("rooms_start_rounds", { roomId, text: body, participants: tags, rounds: roundCount });
      afterSend();
    });

  const askAll = () =>
    run("askall", async () => {
      const body = text.trim();
      if (body === "" || tags.length < 1) return;
      await rpc.call("rooms_ask_all", { roomId, text: body, participants: tags, synthesizer: synthesizer || null });
      afterSend();
    });

  const cancelJob = () => run("cancel", () => rpc.call("rooms_cancel_job", { roomId }));
  const resumeJob = () => run("resume", () => rpc.call("rooms_resume_job", { roomId }));

  const archive = () =>
    run("archive", async () => {
      if (!window.confirm("Archive this room and stop its participant threads?")) return;
      await rpc.call("rooms_archive", { roomId });
      if (!compact) navigate.toPluginPanel(PANEL_PATH, { replace: true });
    });

  const participantAction = (fn: () => Promise<unknown>) => run("participant", async () => { await fn(); refetch(); });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const openThread = (participant: Participant) => {
    if (participant.threadId === null) return;
    const accepted = compact
      ? false
      : panel.openFixedTab({ surface: { kind: "current" }, tab: AGENT_TAB, target: { threadId: participant.threadId } });
    if (!accepted) navigate.toThread(participant.threadId);
  };

  const openDoc = () => {
    if (compact) return;
    panel.openFixedTab({ surface: { kind: "current" }, tab: DOC_TAB, target: { roomId } });
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

  const job = detail.job;
  const canSend = text.trim() !== "" && pendingAction === null;
  const speakers = active.filter((p) => p.threadId !== null);
  const docTarget = detail.room.docPath !== null && detail.room.environmentId !== null
    ? { kind: "workspace" as const, environmentId: detail.room.environmentId, path: detail.room.docPath }
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{detail.room.title}</h2>
          {!compact ? (
            <p className="truncate text-xs text-muted-foreground">
              {detail.workspacePath ?? "Workspace resolves when the first participant is tagged"}
            </p>
          ) : null}
        </div>
        {detail.room.docPath ? (
          compact && docTarget ? (
            <FileLink target={docTarget} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-state-hover">
              <Icon name="FileText" className="size-3.5" />
              {detail.room.docPath}
            </FileLink>
          ) : (
            <button type="button" onClick={openDoc} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-state-hover" title="Open the pinned document">
              <Icon name="FileText" className="size-3.5" />
              {detail.room.docPath}
              <span className="text-muted-foreground">{detail.room.docOwner ? `@${detail.room.docOwner}` : "you"}</span>
            </button>
          )
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => { setShowSettings((v) => !v); setShowAdd(false); }} aria-label="Room settings" aria-pressed={showSettings}>
          <Icon name="Settings" className="size-4" />
        </Button>
        {compact ? (
          <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: roomId })} aria-label="Open the full room page">
            <Icon name="ExternalLink" className="size-4" />
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={archive} disabled={pendingAction !== null} aria-label="Archive room">
            <Icon name="Archive" className="size-4" />
          </Button>
        )}
      </header>

      {showSettings ? <RoomSettings detail={detail} onDone={() => { setShowSettings(false); refetch(); }} /> : null}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {active.map((participant) => (
          <ParticipantChip
            key={participant.handle}
            participant={participant}
            selected={tags.includes(participant.handle)}
            isDocOwner={detail.room.docOwner === participant.handle}
            canSummarize={speakers.some((p) => p.handle !== participant.handle)}
            onToggle={() =>
              setTagged((current) =>
                current.includes(participant.handle) ? current.filter((h) => h !== participant.handle) : [...current, participant.handle],
              )
            }
            onOpen={() => openThread(participant)}
            onCompact={() => participantAction(() => rpc.call("rooms_participant_compact", { roomId, handle: participant.handle }))}
            onReset={(brief) =>
              participantAction(() =>
                rpc.call("rooms_participant_reset", {
                  roomId,
                  handle: participant.handle,
                  brief,
                  summarizer: brief === "summary" ? speakers.find((p) => p.handle !== participant.handle)?.handle ?? null : null,
                }),
              )
            }
            onRemove={() => {
              if (!window.confirm(`Remove @${participant.handle} from the room and stop its thread?`)) return;
              void participantAction(() => rpc.call("rooms_participant_remove", { roomId, handle: participant.handle }));
            }}
          />
        ))}
        <button
          type="button"
          onClick={() => { setShowAdd((v) => !v); setShowSettings(false); }}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-expanded={showAdd}
        >
          <Icon name="UserRoundPlus" className="size-3.5" />
          Add
        </button>
        {!compact ? <span className="ml-auto text-xs text-muted-foreground">Click a name to tag it. Type @handle to tag inline.</span> : null}
      </div>

      {showAdd && options !== null ? <AddParticipantForm detail={detail} options={options} onDone={() => { setShowAdd(false); refetch(); }} /> : null}

      <ChangesBar roomId={roomId} environmentId={detail.room.environmentId} />

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4">
        {detail.messages.length === 0 ? (
          <div className="py-6">
            <EmptyState>
              Empty room. Tag a participant and say something, for example <code>@{handles[0] ?? "claude"} draft a plan for …</code>
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

      {job !== null ? <JobBanner job={job} onCancel={cancelJob} onResume={resumeJob} disabled={pendingAction !== null} /> : null}

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
            job?.paused
              ? `Answer @${job.paused.handle}; sending resumes the job…`
              : tags.length === 0
                ? "Post a note to the room, or tag someone with @handle to get a reply…"
                : `Message to ${tags.map((t) => `@${t}`).join(", ")}…`
          }
          aria-label="Message"
          className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {tags.length === 0 ? "No one tagged: posts a note only." : `Tagged: ${tags.map((t) => `@${t}`).join(", ")}`}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="How many agent-to-agent relays this message may trigger after the tagged replies">
              Hops
              <Input
                type="number"
                min={0}
                max={8}
                value={effectiveHops}
                onChange={(event) => setHops(Math.min(8, Math.max(0, Number(event.target.value) || 0)))}
                className="h-8 w-14 text-xs"
                aria-label="Hop budget"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Rounds
              <Input
                type="number"
                min={1}
                max={20}
                value={roundCount}
                onChange={(event) => setRoundCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
                className="h-8 w-14 text-xs"
                aria-label="Number of rounds"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startRounds}
              disabled={!canSend || tags.length < 2 || job !== null}
              aria-label={tags.length < 2 ? "Tag at least two participants to run rounds" : "Kick off rounds between the tagged participants"}
            >
              <Icon name="Repeat" className="size-3.5" />
              Rounds
            </Button>
            <span className="inline-flex items-stretch overflow-hidden rounded-md border border-input">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-none"
                onClick={askAll}
                disabled={!canSend || tags.length < 1 || job !== null}
                aria-label="Ask every tagged participant in parallel"
              >
                <Icon name="Layers" className="size-3.5" />
                Ask all
              </Button>
              <select
                value={synthesizer}
                onChange={(event) => setSynthesizer(event.target.value)}
                className="h-8 border-l border-input bg-transparent px-1.5 text-xs text-muted-foreground focus-visible:outline-none"
                aria-label="Synthesizer"
                title="Who synthesizes the answers"
              >
                <option value="">no synthesis</option>
                {handles.map((h) => (
                  <option key={h} value={h}>then @{h}</option>
                ))}
              </select>
            </span>
            <Button type="submit" size="sm" disabled={!canSend}>
              <Icon name="Sent" className="size-3.5" />
              Send
            </Button>
          </div>
        </div>
        {actionError !== null ? <p role="alert" className="mt-2 text-xs text-destructive">{actionError}</p> : null}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create room
// ---------------------------------------------------------------------------

interface CreatePreset {
  projectId: string;
  environmentId: string | null;
  title: string;
}

function defaultSeats(options: ContextOptions): SeatDraft[] {
  const available = options.providers.filter((p) => p.available);
  const has = (id: string) => available.some((p) => p.id === id);
  const seats: SeatDraft[] = [];
  const seat = (handle: string, providerId: string, role: Role): SeatDraft => ({ handle, providerId, model: "", reasoningLevel: "", role, roleInstructions: "" });
  if (has("claude-code")) seats.push(seat("claude", "claude-code", "planner"));
  if (has("codex")) seats.push(seat("codex", "codex", "reviewer"));
  const acp = available.find((p) => p.id.startsWith("acp-") && p.models.length > 0) ?? available.find((p) => p.id.startsWith("acp-"));
  if (acp) seats.push(seat(acp.id.replace(/^acp-/, ""), acp.id, "implementer"));
  if (seats.length === 0 && available[0]) seats.push(seat(available[0].id.replace(/[^a-z0-9-]/g, ""), available[0].id, "none"));
  return seats;
}

function CreateRoomForm({ preset, onCreated }: { preset?: CreatePreset; onCreated?: (roomId: string) => void }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const [title, setTitle] = useState(preset?.title ?? "");
  const [projectId, setProjectId] = useState(preset?.projectId ?? "");
  const [seats, setSeats] = useState<SeatDraft[]>([]);
  const [docPath, setDocPath] = useState("");
  const [docOwner, setDocOwner] = useState("");
  const [hops, setHops] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    rpc.call("context_options").then(
      (result) => {
        setOptions(result);
        setSeats(defaultSeats(result));
        const personal = result.projects.find((p) => p.kind !== "standard");
        setProjectId((current) => current || personal?.id || result.projects[0]?.id || "");
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);

  const update = (index: number, patch: Partial<SeatDraft>) => setSeats((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || options === null) return;
    setPending(true);
    setError(null);
    try {
      const { room } = await rpc.call("rooms_create", {
        title: title.trim(),
        projectId,
        environmentId: preset?.environmentId ?? null,
        participants: seats.map(toParticipantInput),
        docPath: docPath.trim() === "" ? null : docPath.trim(),
        docOwner: docPath.trim() === "" || docOwner === "" ? null : docOwner,
        defaultHops: hops,
      });
      if (onCreated) onCreated(room.id);
      else navigate.toPluginPanel(PANEL_PATH, { subPath: room.id, replace: true });
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

  const handles = seats.map((s) => s.handle.trim().toLowerCase()).filter((h) => h !== "");

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <form onSubmit={submit} className="mx-auto w-full max-w-3xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold">New room</h2>
          <p className="text-xs text-muted-foreground">
            {preset?.environmentId
              ? "The room shares this thread's workspace. Participant threads are created the first time each is tagged."
              : "Every participant gets its own thread in one shared workspace. Threads are created the first time each participant is tagged."}
          </p>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Title
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Plan review: session indexer" required />
        </label>
        {preset?.environmentId ? null : (
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
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Participants and roles</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const first = options.providers.find((p) => p.available) ?? options.providers[0];
                if (!first) return;
                setSeats((current) => [...current, { handle: "", providerId: first.id, model: "", reasoningLevel: "", role: "none", roleInstructions: "" }]);
              }}
            >
              <Icon name="Plus" className="size-4" />
              Add seat
            </Button>
          </div>
          <div className="space-y-2">
            {seats.map((seat, index) => (
              <SeatEditor key={index} seat={seat} options={options} onChange={(patch) => update(index, patch)} onRemove={() => setSeats((current) => current.filter((_, i) => i !== index))} />
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-xs text-muted-foreground sm:col-span-2">
            Pinned document (workspace path, optional)
            <Input value={docPath} onChange={(event) => setDocPath(event.target.value)} placeholder=".roundtable/plan.md" />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">
            Document owner
            <select value={docOwner} onChange={(event) => setDocOwner(event.target.value)} className={cn(selectClass, "block h-9 w-full")} disabled={docPath.trim() === ""}>
              <option value="">you</option>
              {handles.map((h) => (
                <option key={h} value={h}>@{h}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Default hops
          <Input type="number" min={0} max={8} value={hops} onChange={(event) => setHops(Math.min(8, Math.max(0, Number(event.target.value) || 0)))} className="h-8 w-16 text-xs" />
          <span>agent-to-agent relays a tagged reply may trigger when it addresses another participant</span>
        </label>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || seats.length === 0 || title.trim() === "" || projectId === ""}>
            <Icon name="MessageSquarePlus" className="size-4" />
            Create room
          </Button>
          {onCreated ? null : (
            <Button type="button" variant="ghost" onClick={() => navigate.toPluginPanel(PANEL_PATH, { replace: true })}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page, tabs, thread panel
// ---------------------------------------------------------------------------

function RoomListItem({ room, active, onSelect }: { room: RoomSummary; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn("w-full rounded-md px-2.5 py-2 text-left hover:bg-state-hover", active && "bg-state-active")}
      >
        <div className="flex items-center gap-1.5 truncate text-sm font-medium">
          {room.jobKind ? <Icon name="Loading" className="size-3 animate-spin text-muted-foreground" /> : null}
          {room.title}
        </div>
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
                <RoomListItem key={room.id} room={room} active={room.id === roomId} onSelect={() => navigate.toPluginPanel(PANEL_PATH, { subPath: room.id })} />
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
              Pick a room or create one. Each room is a shared transcript where you tag agents in, let them relay to each other for a few hops, ask everyone at once, or run bounded rounds until they agree.
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
  return <ThreadChat key={target.target.threadId} threadId={target.target.threadId} variant="compact" layout="contained" className="h-full" />;
}

function DocumentTab() {
  const target = useFixedTabTarget(DOC_TAB);
  const roomId = target?.target.roomId ?? null;
  const { rpc, doc, error, refetch } = useDoc(roomId);
  const { detail } = useRoom(roomId);
  const [pending, setPending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  if (roomId === null) {
    return (
      <div className="p-4">
        <EmptyState>Open a room and click its pinned document to view it here.</EmptyState>
      </div>
    );
  }
  const create = async () => {
    setPending(true);
    setCreateError(null);
    try {
      await rpc.call("rooms_doc_create", { roomId });
      refetch();
    } catch (cause) {
      setCreateError(describeError(cause));
    } finally {
      setPending(false);
    }
  };
  const environmentId = detail?.room.environmentId ?? null;
  const isMarkdown = doc?.path?.toLowerCase().endsWith(".md") ?? false;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <Icon name="FileText" className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">{doc?.path ?? "no pinned document"}</span>
        {doc?.path && environmentId ? (
          <FileLink target={{ kind: "workspace", environmentId, path: doc.path }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <Icon name="ExternalLink" className="size-3.5" />
            Open
          </FileLink>
        ) : null}
        <Button variant="ghost" size="sm" onClick={refetch} aria-label="Refresh document">
          <Icon name="ArrowReloadHorizontal" className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : doc === null ? (
          <EmptyState>Loading…</EmptyState>
        ) : !doc.exists ? (
          <div className="space-y-3">
            <EmptyState>{doc.note ?? "The document does not exist yet."}</EmptyState>
            {doc.path && environmentId ? (
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={create} disabled={pending}>
                  <Icon name="Plus" className="size-3.5" />
                  Create from template
                </Button>
                {createError ? <span className="text-xs text-destructive">{createError}</span> : null}
              </div>
            ) : null}
          </div>
        ) : isMarkdown ? (
          <div className="mx-auto w-full max-w-3xl text-sm">
            <Markdown content={doc.content} />
          </div>
        ) : (
          <SourceCode content={doc.content} path={doc.path ?? "document.txt"} overflow="wrap" />
        )}
      </div>
    </div>
  );
}

function ThreadRoomPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<{ roomId: string | null; preset: CreatePreset } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("rooms_for_thread", { threadId }).then(
      (result) =>
        setState({
          roomId: result.room?.id ?? null,
          preset: { projectId: result.projectId, environmentId: result.environmentId, title: result.title },
        }),
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, threadId]);
  if (error) {
    return (
      <div className="p-4">
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (state === null) {
    return (
      <div className="p-4">
        <EmptyState>Looking for a room in this workspace…</EmptyState>
      </div>
    );
  }
  if (state.roomId === null) {
    return <CreateRoomForm preset={state.preset} onCreated={(roomId) => setState({ ...state, roomId })} />;
  }
  return <RoomView key={state.roomId} roomId={state.roomId} compact />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Roundtable",
    icon: "MessageSquare",
    path: PANEL_PATH,
    component: RoundtablePage,
    fixedTabs: [
      { ...AGENT_TAB, title: "Agent thread", icon: "Bot", layout: "flush", component: AgentThreadTab },
      { ...DOC_TAB, title: "Document", icon: "FileText", layout: "flush", component: DocumentTab },
    ],
  });
  app.slots.threadPanelAction({
    id: "room",
    title: "Roundtable room",
    icon: "MessageSquare",
    layout: "flush",
    component: ThreadRoomPanel,
  });
});
