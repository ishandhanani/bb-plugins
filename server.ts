// bb-plugin-roundtable — server entry.
//
// A room is a shared transcript owned by this plugin. Each participant is an
// ordinary bb thread (one per agent provider) that shares the room's
// environment. When a participant is addressed, the plugin relays every room
// message it has not seen yet, plus an instruction, into that thread. The
// participant's final reply is captured on `thread.idle`, parsed for its
// STANCE / OPEN footer, and posted back to the room. Replies that mention other
// participants can relay onward while the message's hop budget lasts. Jobs
// (rounds, ask-all) drive multi-turn exchanges with a turn cap and end on
// consensus.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire schemas (shared with app.tsx through type-only imports)
// ---------------------------------------------------------------------------

const HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/;
const handleSchema = z
  .string()
  .regex(HANDLE_RE, "handle must be lowercase letters, digits, or dashes");
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const reasoningSchema = z.enum(REASONING_LEVELS);
type ReasoningLevel = z.infer<typeof reasoningSchema>;

export const ROLES = ["none", "planner", "reviewer", "implementer", "custom"] as const;
const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const STANCES = ["agree", "disagree", "need-info", "pass"] as const;
const stanceSchema = z.enum(STANCES);
export type Stance = z.infer<typeof stanceSchema>;

const briefSchema = z.enum(["full", "summary", "none"]);
export type Brief = z.infer<typeof briefSchema>;

const hopsSchema = z.number().int().min(0).max(8);

const participantInputSchema = z.object({
  handle: handleSchema,
  providerId: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  reasoningLevel: reasoningSchema.nullable().optional(),
  role: roleSchema.optional(),
  roleInstructions: z.string().max(4000).nullable().optional(),
});
export type ParticipantInput = z.infer<typeof participantInputSchema>;

const participantSchema = z.object({
  handle: z.string(),
  providerId: z.string(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  role: roleSchema,
  roleInstructions: z.string().nullable(),
  threadId: z.string().nullable(),
  lastSeenSeq: z.number(),
  status: z.string().nullable(),
  turns: z.number(),
  relayedChars: z.number(),
  lastStance: stanceSchema.nullable(),
  removed: z.boolean(),
});
export type Participant = z.infer<typeof participantSchema>;

const messageSchema = z.object({
  seq: z.number(),
  author: z.string(),
  text: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  stance: stanceSchema.nullable(),
  openPoints: z.array(z.string()),
  hopsLeft: z.number(),
  durationMs: z.number().nullable(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof messageSchema>;

const roomSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  docPath: z.string().nullable(),
  docOwner: z.string().nullable(),
  defaultHops: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Room = z.infer<typeof roomSchema>;

const roomSummarySchema = roomSchema.extend({
  handles: z.array(z.string()),
  messageCount: z.number(),
  lastAuthor: z.string().nullable(),
  jobKind: z.string().nullable(),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;

const jobSchema = z
  .object({
    kind: z.enum(["rounds", "askall"]),
    participants: z.array(z.string()),
    totalTurns: z.number(),
    turn: z.number(),
    current: z.string().nullable(),
    inFlight: z.array(z.string()),
    paused: z.object({ handle: z.string(), question: z.string() }).nullable(),
    synthesizer: z.string().nullable(),
    startedAt: z.number(),
  })
  .nullable();
export type Job = z.infer<typeof jobSchema>;

const roomDetailSchema = z.object({
  room: roomSchema,
  participants: z.array(participantSchema),
  messages: z.array(messageSchema),
  job: jobSchema,
  workspacePath: z.string().nullable(),
  hostId: z.string().nullable(),
});
export type RoomDetail = z.infer<typeof roomDetailSchema>;

const changedFileSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changeKind: z.string(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

const docReadSchema = z.object({
  path: z.string().nullable(),
  exists: z.boolean(),
  content: z.string(),
  sha256: z.string().nullable(),
  note: z.string().nullable(),
});
export type DocRead = z.infer<typeof docReadSchema>;

const providerOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  models: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  reasoningLevels: z.array(z.string()),
});
export type ProviderOption = z.infer<typeof providerOptionSchema>;

const contextOptionsSchema = z.object({
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.string() }),
  ),
  providers: z.array(providerOptionSchema),
});
export type ContextOptions = z.infer<typeof contextOptionsSchema>;

const roomForThreadSchema = z.object({
  room: roomSchema.nullable(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  title: z.string(),
});
export type RoomForThread = z.infer<typeof roomForThreadSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const roomIdSchema = z.object({ roomId: z.string() });
const roomHandleSchema = z.object({ roomId: z.string(), handle: handleSchema });
const textSchema = z.string().trim().min(1).max(20_000);

export const rpcContract = defineRpcContract({
  rooms_list: {
    input: z.null(),
    output: z.object({ rooms: z.array(roomSummarySchema) }),
  },
  rooms_create: {
    input: z.object({
      title: z.string().trim().min(1).max(120),
      projectId: z.string().min(1),
      environmentId: z.string().min(1).nullable().optional(),
      participants: z.array(participantInputSchema).min(1).max(8),
      docPath: z.string().trim().max(400).nullable().optional(),
      docOwner: handleSchema.nullable().optional(),
      defaultHops: hopsSchema.optional(),
    }),
    output: z.object({ room: roomSchema }),
  },
  rooms_update: {
    input: z.object({
      roomId: z.string(),
      title: z.string().trim().min(1).max(120).optional(),
      docPath: z.string().trim().max(400).nullable().optional(),
      docOwner: handleSchema.nullable().optional(),
      defaultHops: hopsSchema.optional(),
    }),
    output: z.object({ room: roomSchema }),
  },
  rooms_get: { input: roomIdSchema, output: roomDetailSchema },
  rooms_changes: {
    input: roomIdSchema,
    output: z.object({ files: z.array(changedFileSchema), note: z.string().nullable() }),
  },
  rooms_post: {
    input: z.object({
      roomId: z.string(),
      text: textSchema,
      tags: z.array(handleSchema).max(8),
      hops: hopsSchema.optional(),
    }),
    output: z.object({ seq: z.number(), dispatched: z.array(z.string()) }),
  },
  rooms_start_rounds: {
    input: z.object({
      roomId: z.string(),
      text: textSchema,
      participants: z.array(handleSchema).min(2).max(8),
      rounds: z.number().int().min(1).max(20),
    }),
    output: okSchema,
  },
  rooms_ask_all: {
    input: z.object({
      roomId: z.string(),
      text: textSchema,
      participants: z.array(handleSchema).min(1).max(8),
      synthesizer: handleSchema.nullable().optional(),
    }),
    output: okSchema,
  },
  rooms_cancel_job: { input: roomIdSchema, output: okSchema },
  rooms_resume_job: { input: roomIdSchema, output: okSchema },
  rooms_archive: { input: roomIdSchema, output: okSchema },
  rooms_add_participant: {
    input: z.object({
      roomId: z.string(),
      participant: participantInputSchema,
      brief: briefSchema,
      summarizer: handleSchema.nullable().optional(),
    }),
    output: okSchema,
  },
  rooms_participant_compact: { input: roomHandleSchema, output: okSchema },
  rooms_participant_reset: {
    input: roomHandleSchema.extend({ brief: briefSchema, summarizer: handleSchema.nullable().optional() }),
    output: okSchema,
  },
  rooms_participant_remove: { input: roomHandleSchema, output: okSchema },
  rooms_doc_read: { input: roomIdSchema, output: docReadSchema },
  rooms_doc_create: { input: roomIdSchema, output: docReadSchema },
  rooms_for_thread: { input: z.object({ threadId: z.string() }), output: roomForThreadSchema },
  context_options: { input: z.null(), output: contextOptionsSchema },
});

/** Realtime channel app.tsx listens on; payload is `{ roomId }`. */
export const ROOM_CHANGED = "room-changed";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Append-only from here on: the host records each statement's hash.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT,
     doc_path TEXT,
     doc_owner TEXT,
     default_hops INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     archived_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS participants (
     room_id TEXT NOT NULL,
     handle TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     model TEXT,
     reasoning_level TEXT,
     role TEXT NOT NULL DEFAULT 'none',
     role_instructions TEXT,
     thread_id TEXT,
     last_seen_seq INTEGER NOT NULL DEFAULT 0,
     turns INTEGER NOT NULL DEFAULT 0,
     relayed_chars INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     removed_at INTEGER,
     PRIMARY KEY (room_id, handle)
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     room_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     author TEXT NOT NULL,
     text TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
     stance TEXT,
     open_points TEXT NOT NULL DEFAULT '[]',
     hops_left INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS participants_thread_idx ON participants(thread_id)`,
];

interface RoomRow {
  id: string;
  title: string;
  project_id: string;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  doc_path: string | null;
  doc_owner: string | null;
  default_hops: number;
}
interface ParticipantRow {
  room_id: string;
  handle: string;
  provider_id: string;
  model: string | null;
  reasoning_level: string | null;
  thread_id: string | null;
  last_seen_seq: number;
  created_at: number;
  role: string;
  role_instructions: string | null;
  turns: number;
  relayed_chars: number;
  removed_at: number | null;
}
interface MessageRow {
  room_id: string;
  seq: number;
  author: string;
  text: string;
  tags: string;
  created_at: number;
  stance: string | null;
  open_points: string;
  hops_left: number;
  duration_ms: number | null;
}
interface MessageMeta {
  stance?: Stance | null;
  openPoints?: string[];
  hopsLeft?: number;
  durationMs?: number | null;
}

function createStore(db: Database.Database) {
  const q = {
    roomById: db.prepare<[string], RoomRow>(
      `SELECT * FROM rooms WHERE id = ? AND archived_at IS NULL`,
    ),
    roomByTitle: db.prepare<[string], RoomRow>(
      `SELECT * FROM rooms WHERE lower(title) = lower(?) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
    ),
    roomByEnvironment: db.prepare<[string], RoomRow>(
      `SELECT * FROM rooms WHERE environment_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
    ),
    rooms: db.prepare<[], RoomRow>(
      `SELECT * FROM rooms WHERE archived_at IS NULL ORDER BY updated_at DESC`,
    ),
    insertRoom: db.prepare<[string, string, string, string | null, string | null, string | null, number, number, number]>(
      `INSERT INTO rooms (id, title, project_id, environment_id, doc_path, doc_owner, default_hops, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateRoom: db.prepare<[string, string | null, string | null, number, number, string]>(
      `UPDATE rooms SET title = ?, doc_path = ?, doc_owner = ?, default_hops = ?, updated_at = ? WHERE id = ?`,
    ),
    touchRoom: db.prepare<[number, string]>(`UPDATE rooms SET updated_at = ? WHERE id = ?`),
    setRoomEnvironment: db.prepare<[string, string]>(
      `UPDATE rooms SET environment_id = ? WHERE id = ? AND environment_id IS NULL`,
    ),
    archiveRoom: db.prepare<[number, string]>(`UPDATE rooms SET archived_at = ? WHERE id = ?`),
    participants: db.prepare<[string], ParticipantRow>(
      `SELECT * FROM participants WHERE room_id = ? AND removed_at IS NULL ORDER BY created_at ASC`,
    ),
    allParticipants: db.prepare<[string], ParticipantRow>(
      `SELECT * FROM participants WHERE room_id = ? ORDER BY created_at ASC`,
    ),
    participant: db.prepare<[string, string], ParticipantRow>(
      `SELECT * FROM participants WHERE room_id = ? AND handle = ?`,
    ),
    participantByThread: db.prepare<[string], ParticipantRow>(
      `SELECT * FROM participants WHERE thread_id = ?`,
    ),
    insertParticipant: db.prepare<
      [string, string, string, string | null, string | null, string, string | null, number, number]
    >(
      `INSERT INTO participants (room_id, handle, provider_id, model, reasoning_level, role, role_instructions, last_seen_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setParticipantThread: db.prepare<[string | null, string, string]>(
      `UPDATE participants SET thread_id = ? WHERE room_id = ? AND handle = ?`,
    ),
    setLastSeen: db.prepare<[number, string, string]>(
      `UPDATE participants SET last_seen_seq = ? WHERE room_id = ? AND handle = ?`,
    ),
    addRelayed: db.prepare<[number, string, string]>(
      `UPDATE participants SET relayed_chars = relayed_chars + ? WHERE room_id = ? AND handle = ?`,
    ),
    resetRelayed: db.prepare<[string, string]>(
      `UPDATE participants SET relayed_chars = 0 WHERE room_id = ? AND handle = ?`,
    ),
    bumpTurns: db.prepare<[string, string]>(
      `UPDATE participants SET turns = turns + 1 WHERE room_id = ? AND handle = ?`,
    ),
    removeParticipant: db.prepare<[number, string, string]>(
      `UPDATE participants SET removed_at = ? WHERE room_id = ? AND handle = ?`,
    ),
    messages: db.prepare<[string, number], MessageRow>(
      `SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC`,
    ),
    lastMessage: db.prepare<[string], MessageRow>(
      `SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1`,
    ),
    lastMessageBy: db.prepare<[string, string, number], MessageRow>(
      `SELECT * FROM messages WHERE room_id = ? AND author = ? AND seq > ? ORDER BY seq DESC LIMIT 1`,
    ),
    messageCount: db.prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE room_id = ?`,
    ),
    maxSeq: db.prepare<[string], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE room_id = ?`,
    ),
    insertMessage: db.prepare<
      [string, number, string, string, string, number, string | null, string, number, number | null]
    >(
      `INSERT INTO messages (room_id, seq, author, text, tags, created_at, stance, open_points, hops_left, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  };

  const appendMessage = db.transaction(
    (roomId: string, author: string, text: string, tags: string[], meta: MessageMeta = {}): MessageRow => {
      const seq = (q.maxSeq.get(roomId)?.seq ?? 0) + 1;
      const createdAt = Date.now();
      const row: MessageRow = {
        room_id: roomId,
        seq,
        author,
        text,
        tags: JSON.stringify(tags),
        created_at: createdAt,
        stance: meta.stance ?? null,
        open_points: JSON.stringify(meta.openPoints ?? []),
        hops_left: meta.hopsLeft ?? 0,
        duration_ms: meta.durationMs ?? null,
      };
      q.insertMessage.run(
        row.room_id, row.seq, row.author, row.text, row.tags, row.created_at,
        row.stance, row.open_points, row.hops_left, row.duration_ms,
      );
      q.touchRoom.run(createdAt, roomId);
      return row;
    },
  );

  const insertParticipant = (roomId: string, p: ParticipantInput, lastSeenSeq: number): void => {
    q.insertParticipant.run(
      roomId,
      p.handle,
      p.providerId,
      p.model ?? null,
      p.reasoningLevel ?? null,
      p.role ?? "none",
      p.role === "custom" ? (p.roleInstructions ?? null) : null,
      lastSeenSeq,
      Date.now(),
    );
  };

  const createRoom = db.transaction(
    (input: {
      title: string;
      projectId: string;
      environmentId: string | null;
      participants: ParticipantInput[];
      docPath: string | null;
      docOwner: string | null;
      defaultHops: number;
    }): RoomRow => {
      const id = randomBytes(5).toString("hex");
      const now = Date.now();
      q.insertRoom.run(id, input.title, input.projectId, input.environmentId, input.docPath, input.docOwner, input.defaultHops, now, now);
      for (const p of input.participants) insertParticipant(id, p, 0);
      return {
        id,
        title: input.title,
        project_id: input.projectId,
        environment_id: input.environmentId,
        created_at: now,
        updated_at: now,
        archived_at: null,
        doc_path: input.docPath,
        doc_owner: input.docOwner,
        default_hops: input.defaultHops,
      };
    },
  );

  return {
    q,
    appendMessage,
    createRoom,
    insertParticipant,
    room(id: string): RoomRow | undefined {
      return q.roomById.get(id) ?? q.roomByTitle.get(id);
    },
    rooms(): RoomRow[] {
      return q.rooms.all();
    },
    participants(roomId: string): ParticipantRow[] {
      return q.participants.all(roomId);
    },
    handles(roomId: string): string[] {
      return q.participants.all(roomId).map((p) => p.handle);
    },
    participant(roomId: string, handle: string): ParticipantRow | undefined {
      const row = q.participant.get(roomId, handle);
      return row === undefined || row.removed_at !== null ? undefined : row;
    },
    participantByThread(threadId: string): ParticipantRow | undefined {
      return q.participantByThread.get(threadId);
    },
    messages(roomId: string, afterSeq = 0): MessageRow[] {
      return q.messages.all(roomId, afterSeq);
    },
    maxSeq(roomId: string): number {
      return q.maxSeq.get(roomId)?.seq ?? 0;
    },
  };
}
type Store = ReturnType<typeof createStore>;

// ---------------------------------------------------------------------------
// Reply parsing: the STANCE / OPEN footer
// ---------------------------------------------------------------------------

const STANCE_LINE = /^\s*[*_#>\-\s]*stance[*_]*\s*[:\-]\s*[*_]*\s*(agree|disagree|need[\s-]?info|pass)\b/i;
const OPEN_LINE = /^\s*[*_#>\-\s]*open[*_]*\s*[:\-]\s*(.*)$/i;
const LIST_LINE = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/;
const NONE_RE = /^[*_\s]*(none|n\/a|nothing|no open points|-)?[*_\s.]*$/i;

interface ParsedReply {
  stance: Stance | null;
  openPoints: string[];
  body: string;
}

export function parseReply(text: string): ParsedReply {
  const lines = text.split("\n");
  let stanceIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (STANCE_LINE.test(lines[i])) {
      stanceIdx = i;
      break;
    }
  }
  if (stanceIdx === -1) return { stance: null, openPoints: [], body: text.trim() };
  const raw = (lines[stanceIdx].match(STANCE_LINE) as RegExpMatchArray)[1].toLowerCase().replace(/[\s-]+/g, "");
  const stance: Stance = raw === "needinfo" ? "need-info" : (raw as Stance);

  let openIdx = -1;
  for (let i = stanceIdx + 1; i < lines.length; i++) {
    if (OPEN_LINE.test(lines[i])) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) {
    for (let i = stanceIdx - 1; i >= Math.max(0, stanceIdx - 8); i--) {
      if (OPEN_LINE.test(lines[i])) {
        openIdx = i;
        break;
      }
    }
  }
  const openPoints: string[] = [];
  let openEnd = openIdx;
  if (openIdx !== -1) {
    const rest = (lines[openIdx].match(OPEN_LINE) as RegExpMatchArray)[1].trim();
    if (!NONE_RE.test(rest)) {
      // "OPEN: 1. first 2. second" on one line splits into separate points.
      const inline = rest.split(/\s+(?=\d+[.)]\s)/).map((part) => part.replace(/^\d+[.)]\s*/, "").replace(/^[*_]+|[*_]+$/g, "").trim());
      openPoints.push(...inline.filter((part) => part !== ""));
    }
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (i === stanceIdx) break;
      const item = lines[i].match(LIST_LINE);
      if (item === null) break;
      openPoints.push(item[1].trim());
      openEnd = i;
    }
  }
  const footerStart = openIdx === -1 ? stanceIdx : Math.min(stanceIdx, openIdx);
  const footerEnd = Math.max(stanceIdx, openEnd);
  const body = [...lines.slice(0, footerStart), ...lines.slice(footerEnd + 1)].join("\n").trim();
  return { stance, openPoints: openPoints.filter((p) => p !== ""), body };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    environmentId: row.environment_id,
    docPath: row.doc_path,
    docOwner: row.doc_owner,
    defaultHops: row.default_hops,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonStrings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function isStance(value: string | null): value is Stance {
  return value !== null && (STANCES as readonly string[]).includes(value);
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function toMessage(row: MessageRow): Message {
  const isAgent = row.author !== "user" && row.author !== "system";
  const body = isAgent ? parseReply(row.text).body : row.text;
  return {
    seq: row.seq,
    author: row.author,
    text: row.text,
    body,
    tags: parseJsonStrings(row.tags),
    stance: isStance(row.stance) ? row.stance : null,
    openPoints: parseJsonStrings(row.open_points),
    hopsLeft: row.hops_left,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function authorLabel(author: string): string {
  return author === "user" || author === "system" ? author : `@${author}`;
}

/** `@handle` tokens in text that name a room participant other than `self`. */
function mentionsIn(text: string, handles: readonly string[], self?: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[^a-z0-9])@([a-z][a-z0-9-]*)/gi)) {
    const handle = match[2].toLowerCase();
    if (handle !== self && handles.includes(handle)) found.add(handle);
  }
  return [...found];
}

function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function formatTranscript(rows: readonly MessageRow[]): string {
  return rows
    .map((row) => `### ${authorLabel(row.author)} (#${row.seq})\n${row.text.trim()}`)
    .join("\n\n");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isReasoningLevel(value: string | null): value is ReasoningLevel {
  return value !== null && (REASONING_LEVELS as readonly string[]).includes(value);
}

function joinPath(root: string, relative: string): string {
  const cleaned = relative.replace(/^\/+/, "");
  return `${root.replace(/\/+$/, "")}/${cleaned}`;
}

// ---------------------------------------------------------------------------
// Role contracts and instructions
// ---------------------------------------------------------------------------

const ROLE_CONTRACTS: Record<Exclude<Role, "custom" | "none">, string> = {
  planner: [
    "Role: planner. You own the proposal.",
    "Write or revise it as numbered decisions, each with a one-line rationale.",
    "When revising, start with a \"Changes since last version\" list.",
    "Answer every reviewer finding by its number: accept (and apply it), reject (with the reason), or defer (with what would settle it).",
    "Keep the proposal self-contained so a newcomer can read only the latest version.",
  ].join(" "),
  reviewer: [
    "Role: reviewer. Review critically and independently.",
    "Return numbered findings. Each finding has: severity (blocker, major, minor, nit), the exact claim or file:line it targets, why it is wrong or risky, and a concrete fix.",
    "Verify claims against the workspace before asserting them. Do not restate the proposal. Say what is missing.",
    "If nothing is wrong, say so plainly and stop.",
  ].join(" "),
  implementer: [
    "Role: implementer. You turn accepted decisions into changes, only when the user asks for implementation in this room.",
    "Before editing, list the files you will touch. Afterwards report what changed, how you verified it (commands and results), and what you did not do.",
    "Do not redesign. Raise design objections as numbered findings addressed to the planner.",
  ].join(" "),
};

function roleContract(row: ParticipantRow): string | null {
  const role = isRole(row.role) ? row.role : "none";
  if (role === "none") return null;
  if (role === "custom") return row.role_instructions ? `Role: ${row.role_instructions.trim()}` : null;
  return ROLE_CONTRACTS[role];
}

const REPLY_FORMAT = [
  "Reply format. End every reply with exactly these two lines, in this order:",
  "STANCE: agree | disagree | need-info | pass",
  "OPEN: none, or a numbered list of unresolved points on the following lines",
  "agree means you accept the current position with nothing blocking. disagree means you object and OPEN says exactly what. need-info means you cannot proceed without an answer from the user; put the question in OPEN. pass means you have nothing to add this turn.",
  "Address a participant with @handle when you want that participant specifically to respond.",
].join("\n");

const FOOTER_REMINDER = "End with the two footer lines: STANCE and OPEN.";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface ReplyEvent {
  text: string;
  stance: Stance | null;
  openPoints: string[];
  mentions: string[];
  seq: number;
}

interface PendingTurn {
  resolve(reply: ReplyEvent): void;
  reject(error: Error): void;
}

interface Awaiting {
  hopsLeft: number;
  deliveredAt: number;
  job: boolean;
  triggeredBy: string;
}

interface JobState {
  kind: "rounds" | "askall";
  roomId: string;
  participants: string[];
  totalTurns: number;
  turn: number;
  current: string | null;
  inFlight: Set<string>;
  paused: { handle: string; question: string } | null;
  synthesizer: string | null;
  startedAt: number;
  startSeq: number;
  controller: AbortController;
  resume: (() => void) | null;
}

const REPLY_TIMEOUT_MS = 30 * 60_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hideParticipantThreads: {
      type: "boolean",
      label: "Hide participant threads from the sidebar",
      default: true,
    },
  });
  const { hideParticipantThreads } = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store: Store = createStore(db);

  /** Promises awaiting a reply, keyed by `${roomId}/${handle}` (jobs and briefings). */
  const pending = new Map<string, PendingTurn[]>();
  /** Participants the room expects a reply from; set by every delivery. */
  const awaiting = new Map<string, Awaiting>();
  const jobs = new Map<string, JobState>();
  const spawnLocks = new Map<string, Promise<unknown>>();

  const pendingKey = (roomId: string, handle: string) => `${roomId}/${handle}`;

  function publish(roomId: string): void {
    bb.realtime.publish(ROOM_CHANGED, { roomId });
  }

  function postSystem(roomId: string, text: string): void {
    store.appendMessage(roomId, "system", text, []);
    publish(roomId);
  }

  function waitForReply(roomId: string, handle: string, signal?: AbortSignal): Promise<ReplyEvent> {
    const key = pendingKey(roomId, handle);
    return new Promise<ReplyEvent>((resolve, reject) => {
      const entry: PendingTurn = {
        resolve: (reply) => {
          cleanup();
          resolve(reply);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        detach();
        reject(new Error(`timed out waiting for @${handle}`));
      }, REPLY_TIMEOUT_MS);
      const onAbort = () => {
        detach();
        reject(new Error("cancelled"));
      };
      function detach() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const list = pending.get(key);
        if (list === undefined) return;
        const rest = list.filter((candidate) => candidate !== entry);
        if (rest.length === 0) pending.delete(key);
        else pending.set(key, rest);
      }
      function cleanup() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(key, [...(pending.get(key) ?? []), entry]);
    });
  }

  function settlePending(roomId: string, handle: string, outcome: { reply: ReplyEvent } | { error: Error }): boolean {
    const key = pendingKey(roomId, handle);
    const expected = awaiting.delete(key);
    const list = pending.get(key);
    if (list === undefined || list.length === 0) return expected;
    pending.delete(key);
    for (const entry of list) {
      if ("reply" in outcome) entry.resolve(outcome.reply);
      else entry.reject(outcome.error);
    }
    return true;
  }

  async function providerDirectory() {
    const providers = await bb.sdk.providers.list();
    return new Map(providers.map((provider) => [provider.id, provider]));
  }

  function permissionModeFor(modes: readonly string[]): "auto" | "accept-edits" | "full" | undefined {
    if (modes.includes("auto")) return "auto";
    if (modes.includes("accept-edits")) return "accept-edits";
    if (modes.includes("full")) return "full";
    return undefined;
  }

  function editAuthority(room: RoomRow, participant: ParticipantRow): string {
    const owner = room.doc_path !== null && room.doc_owner === participant.handle;
    if (owner) {
      return `You may edit the pinned document ${room.doc_path}. Do not modify other files unless the user explicitly asks you to in this room.`;
    }
    if (participant.role === "implementer") {
      return "Modify files only when the user asks for implementation in this room. Otherwise read-only.";
    }
    return "Do not modify files unless the user explicitly asks you to in this room. Reading files and running read-only commands to check claims is encouraged.";
  }

  function docNotice(room: RoomRow, participant: ParticipantRow): string | null {
    if (room.doc_path === null) return null;
    const owner = room.doc_owner === null ? "the user" : `@${room.doc_owner}`;
    const you = room.doc_owner === participant.handle;
    return `Pinned document: ${room.doc_path} (relative to the workspace). Read it before replying. ${
      you
        ? "You own it: apply accepted changes to it and list what changed."
        : `Only ${owner} edits it; propose changes as numbered findings.`
    }`;
  }

  function introFor(room: RoomRow, participant: ParticipantRow, others: readonly ParticipantRow[]): string {
    const roster = others.length === 0
      ? "no other agents yet"
      : others
          .map((other) => `@${other.handle} (${other.provider_id}${other.role !== "none" ? `, ${other.role}` : ""})`)
          .join(", ");
    const sections = [
      `You are @${participant.handle} in "${room.title}", a Roundtable room shared by the user and other agents: ${roster}.`,
      [
        "How the room works:",
        "- Room messages are relayed to you in order with their author. \"user\" is the human. \"@name\" is another agent.",
        `- Your final reply is posted to the room verbatim as @${participant.handle}. Write for the room. Do not restate the relayed messages or narrate the relay.`,
        "- Be concrete. Disagree with specifics. Agree briefly. Keep it short unless the user asks for detail.",
        `- ${editAuthority(room, participant)} All participants share this workspace.`,
        `- To read the room: bb roundtable show ${room.id}. To pull another agent in mid-turn: bb roundtable say ${room.id} --to <handle> "<message>". Your final reply is still posted.`,
      ].join("\n"),
    ];
    const contract = roleContract(participant);
    if (contract !== null) sections.push(contract);
    const doc = docNotice(room, participant);
    if (doc !== null) sections.push(doc);
    sections.push(REPLY_FORMAT);
    return sections.join("\n\n");
  }

  function sendText(threadId: string, text: string) {
    return bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  async function sendOrSpawn(room: RoomRow, participant: ParticipantRow, text: string): Promise<void> {
    if (participant.thread_id !== null) {
      await sendText(participant.thread_id, text);
      return;
    }
    const { handle } = participant;
    // Serialize first spawns per room so every participant lands in the
    // environment the first spawn resolved.
    const prev = spawnLocks.get(room.id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const fresh = store.participant(room.id, handle);
      const freshRoom = store.room(room.id);
      if (fresh === undefined || freshRoom === undefined) return;
      if (fresh.thread_id !== null) {
        await sendText(fresh.thread_id, text);
        return;
      }
      const providers = await providerDirectory();
      const provider = providers.get(fresh.provider_id);
      const permissionMode = permissionModeFor(provider?.capabilities.permissionModes ?? []);
      const thread = await bb.sdk.threads.spawn({
        projectId: freshRoom.project_id,
        environment: freshRoom.environment_id === null
          ? { type: "project-default" }
          : { type: "reuse", environmentId: freshRoom.environment_id },
        providerId: fresh.provider_id,
        ...(fresh.model === null ? {} : { model: fresh.model }),
        ...(isReasoningLevel(fresh.reasoning_level) ? { reasoningLevel: fresh.reasoning_level } : {}),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        title: `Roundtable ${freshRoom.title}: @${fresh.handle}`,
        visibility: hideParticipantThreads ? "hidden" : "visible",
        prompt: text,
      });
      store.q.setParticipantThread.run(thread.id, room.id, handle);
      if (freshRoom.environment_id === null && thread.environmentId !== null) {
        store.q.setRoomEnvironment.run(thread.environmentId, room.id);
      }
    });
    spawnLocks.set(room.id, run.catch(() => undefined));
    await run;
  }

  interface DeliverOptions {
    hopsLeft: number;
    job: boolean;
    triggeredBy: string;
  }

  /**
   * Relay everything `participant` has not seen, plus `instruction`, into its
   * thread (spawning the thread on first contact). Resolves once the message
   * is accepted; the reply arrives through `thread.idle`.
   */
  async function deliver(roomId: string, handle: string, instruction: string, options: DeliverOptions): Promise<void> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const participant = store.participant(room.id, handle);
    if (participant === undefined) throw new Error(`@${handle} is not in room ${room.id}`);
    const others = store.participants(room.id).filter((other) => other.handle !== handle);
    const pendingRows = store.messages(room.id, participant.last_seen_seq);
    const unseen = pendingRows.filter((row) => row.author !== handle);
    const deliveredUpTo = Math.max(participant.last_seen_seq, ...pendingRows.map((row) => row.seq));

    const sections: string[] = [];
    if (participant.thread_id === null) sections.push(introFor(room, participant, others));
    if (unseen.length > 0) sections.push(`New messages in the room:\n\n${formatTranscript(unseen)}`);
    const doc = participant.thread_id === null ? null : docNotice(room, participant);
    if (doc !== null) sections.push(doc);
    sections.push(`${instruction} ${FOOTER_REMINDER}`);
    const text = sections.join("\n\n");

    const key = pendingKey(room.id, handle);
    awaiting.set(key, { hopsLeft: options.hopsLeft, deliveredAt: Date.now(), job: options.job, triggeredBy: options.triggeredBy });
    try {
      await sendOrSpawn(room, participant, text);
    } catch (cause) {
      if (!pending.has(key)) awaiting.delete(key);
      throw cause;
    }
    store.q.setLastSeen.run(deliveredUpTo, room.id, handle);
    store.q.addRelayed.run(text.length, room.id, handle);
    publish(room.id);
  }

  /** Deliver to each handle in order; failures become room system messages. */
  async function dispatch(roomId: string, handles: readonly string[], instruction: string, options: DeliverOptions): Promise<string[]> {
    const dispatched: string[] = [];
    for (const handle of handles) {
      try {
        await deliver(roomId, handle, instruction, options);
        dispatched.push(handle);
      } catch (cause) {
        const message = errorMessage(cause);
        bb.log.warn(`deliver to @${handle} in ${roomId} failed: ${message}`);
        postSystem(roomId, `Could not reach @${handle}: ${message}`);
      }
    }
    return dispatched;
  }

  function postFrom(roomId: string, author: string, text: string, explicitTags: readonly string[], hopsLeft: number): { seq: number; tags: string[] } {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const handles = store.handles(room.id);
    const tags = uniq([
      ...explicitTags.filter((tag) => handles.includes(tag) && tag !== author),
      ...mentionsIn(text, handles, author),
    ]);
    const row = store.appendMessage(room.id, author, text, tags, { hopsLeft });
    publish(room.id);
    return { seq: row.seq, tags };
  }

  const USER_TAG_INSTRUCTION = "You were tagged by the user. Reply to the room.";
  const addressedInstruction = (by: string) => `You were addressed by @${by}. Reply to the room.`;

  // -- jobs: rounds and ask-all --------------------------------------------

  function jobView(roomId: string): Job {
    const state = jobs.get(roomId);
    if (state === undefined) return null;
    return {
      kind: state.kind,
      participants: state.participants,
      totalTurns: state.totalTurns,
      turn: state.turn,
      current: state.current,
      inFlight: [...state.inFlight],
      paused: state.paused,
      synthesizer: state.synthesizer,
      startedAt: state.startedAt,
    };
  }

  function requireJobFree(room: RoomRow, participants: readonly string[]): string[] {
    if (jobs.has(room.id)) throw new Error("a job is already running in this room");
    const handles = store.handles(room.id);
    const missing = participants.filter((handle) => !handles.includes(handle));
    if (missing.length > 0) throw new Error(`not in room: ${missing.map((h) => `@${h}`).join(", ")}`);
    return uniq(participants);
  }

  function newJob(kind: JobState["kind"], room: RoomRow, participants: string[], totalTurns: number, synthesizer: string | null): JobState {
    const state: JobState = {
      kind,
      roomId: room.id,
      participants,
      totalTurns,
      turn: 0,
      current: null,
      inFlight: new Set(),
      paused: null,
      synthesizer,
      startedAt: Date.now(),
      startSeq: store.maxSeq(room.id),
      controller: new AbortController(),
      resume: null,
    };
    jobs.set(room.id, state);
    return state;
  }

  function startRounds(roomId: string, text: string, participants: string[], rounds: number, author: string): void {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const order = requireJobFree(room, participants);
    if (order.length < 2) throw new Error("rounds need at least two participants");
    store.appendMessage(room.id, author, text, order, { hopsLeft: 0 });
    const state = newJob("rounds", room, order, rounds * order.length, null);
    postSystem(
      room.id,
      `Rounds started: ${order.map((h) => `@${h}`).join(", ")} for up to ${rounds} round(s) (${state.totalTurns} turns). The next speaker is whoever the last reply addressed, else the next in order. Rounds end early once everyone is at STANCE agree with nothing OPEN.`,
    );
    void runRounds(state);
  }

  /** Latest stance and open points per participant since the job began. */
  function consensus(state: JobState): { settled: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const handle of state.participants) {
      const last = store.q.lastMessageBy.get(state.roomId, handle, state.startSeq);
      if (last === undefined) {
        missing.push(handle);
        continue;
      }
      const stance = isStance(last.stance) ? last.stance : null;
      const open = parseJsonStrings(last.open_points);
      if (!(stance === "agree" || stance === "pass") || open.length > 0) missing.push(handle);
    }
    return { settled: missing.length === 0, missing };
  }

  async function pauseForUser(state: JobState, handle: string, question: string): Promise<void> {
    state.paused = { handle, question };
    state.current = null;
    postSystem(state.roomId, `Paused: @${handle} needs input from you. ${question} Reply in the room to continue.`);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error("cancelled"));
      state.controller.signal.addEventListener("abort", onAbort, { once: true });
      state.resume = () => {
        state.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
    state.paused = null;
    state.resume = null;
  }

  async function takeTurn(state: JobState, handle: string, instruction: string): Promise<ReplyEvent> {
    state.current = handle;
    state.inFlight.add(handle);
    publish(state.roomId);
    const reply = waitForReply(state.roomId, handle, state.controller.signal);
    try {
      await deliver(state.roomId, handle, instruction, { hopsLeft: 0, job: true, triggeredBy: "job" });
    } catch (cause) {
      settlePending(state.roomId, handle, { error: new Error(errorMessage(cause)) });
      throw cause;
    }
    try {
      return await reply;
    } finally {
      state.inFlight.delete(handle);
    }
  }

  async function runRounds(state: JobState): Promise<void> {
    const { roomId, controller, participants } = state;
    const signal = controller.signal;
    const n = participants.length;
    let next = participants[0];
    let outcome = `stopped after ${state.totalTurns} turns without a settled agreement.`;
    try {
      while (state.turn < state.totalTurns) {
        if (signal.aborted) throw new Error("cancelled");
        const handle = next;
        state.turn++;
        const round = Math.ceil(state.turn / n);
        const others = participants.filter((h) => h !== handle).map((h) => `@${h}`).join(", ");
        const instruction = [
          `Turn ${state.turn} of ${state.totalTurns} (round ${round}). It is your turn, @${handle}.`,
          `Respond to the latest points from ${others} by number where they numbered them. Resolve disagreements with specifics.`,
          "If you fully agree and have nothing to add, reply briefly with STANCE: agree and OPEN: none. If you have nothing new this turn, use STANCE: pass.",
        ].join(" ");
        const reply = await takeTurn(state, handle, instruction);
        if (reply.stance === "need-info") {
          await pauseForUser(state, handle, reply.openPoints[0] ?? "See the open points above.");
          next = handle;
          continue;
        }
        const spoken = new Set(store.messages(roomId, state.startSeq).map((m) => m.author));
        if (participants.every((h) => spoken.has(h))) {
          const { settled } = consensus(state);
          if (settled) {
            outcome = `settled after ${state.turn} turns (round ${round}): everyone is at agree with nothing open.`;
            break;
          }
        }
        const addressed = reply.mentions.filter((h) => participants.includes(h) && h !== handle);
        next = addressed[0] ?? participants[(participants.indexOf(handle) + 1) % n];
      }
    } catch (cause) {
      outcome = signal.aborted ? "cancelled by the user." : `stopped: ${errorMessage(cause)}`;
    } finally {
      jobs.delete(roomId);
      state.current = null;
      if (store.room(roomId) !== undefined) postSystem(roomId, `Rounds ${outcome}`);
    }
  }

  function startAskAll(roomId: string, text: string, participants: string[], synthesizer: string | null, author: string): void {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const targets = requireJobFree(room, participants);
    if (synthesizer !== null && !store.handles(room.id).includes(synthesizer)) throw new Error(`@${synthesizer} is not in room`);
    store.appendMessage(room.id, author, text, targets, { hopsLeft: 0 });
    const state = newJob("askall", room, targets, targets.length + (synthesizer === null ? 0 : 1), synthesizer);
    postSystem(
      room.id,
      `Asking ${targets.map((h) => `@${h}`).join(", ")} independently${synthesizer === null ? "." : `, then @${synthesizer} synthesizes.`}`,
    );
    void runAskAll(state);
  }

  async function runAskAll(state: JobState): Promise<void> {
    const { roomId, controller, participants, synthesizer } = state;
    const signal = controller.signal;
    let outcome = "finished.";
    try {
      const instruction = "Answer the question above independently. Do not wait for or defer to the other participants; they are answering in parallel.";
      const results = await Promise.allSettled(
        participants.map(async (handle) => {
          state.inFlight.add(handle);
          publish(roomId);
          const reply = waitForReply(roomId, handle, signal);
          try {
            await deliver(roomId, handle, instruction, { hopsLeft: 0, job: true, triggeredBy: "job" });
          } catch (cause) {
            settlePending(roomId, handle, { error: new Error(errorMessage(cause)) });
            throw cause;
          }
          try {
            return await reply;
          } finally {
            state.inFlight.delete(handle);
            state.turn++;
            publish(roomId);
          }
        }),
      );
      if (signal.aborted) throw new Error("cancelled");
      const answered = participants.filter((_, i) => results[i].status === "fulfilled");
      const failed = participants.filter((_, i) => results[i].status === "rejected");
      if (failed.length > 0) postSystem(roomId, `No answer from ${failed.map((h) => `@${h}`).join(", ")}.`);
      if (synthesizer !== null && answered.length > 0) {
        state.turn++;
        const synthInstruction = [
          `Synthesize the independent answers from ${answered.map((h) => `@${h}`).join(", ")} above.`,
          "List the agreements, then each disagreement with who holds which view and why, then one recommendation with its rationale.",
          "Do not add a new answer of your own beyond the recommendation.",
        ].join(" ");
        await takeTurn(state, synthesizer, synthInstruction);
      }
      outcome = `finished: ${answered.length} of ${participants.length} answered${synthesizer === null ? "." : `, synthesized by @${synthesizer}.`}`;
    } catch (cause) {
      outcome = signal.aborted ? "cancelled by the user." : `stopped: ${errorMessage(cause)}`;
    } finally {
      jobs.delete(roomId);
      state.current = null;
      if (store.room(roomId) !== undefined) postSystem(roomId, `Ask-all ${outcome}`);
    }
  }

  async function cancelJob(roomId: string): Promise<void> {
    const state = jobs.get(roomId);
    if (state === undefined) return;
    const running = [...state.inFlight, ...(state.current === null ? [] : [state.current])];
    state.controller.abort();
    for (const handle of uniq(running)) {
      // Drop the pending wait first so the stop's idle transition is not
      // mistaken for a reply, then release the participant's runtime.
      settlePending(roomId, handle, { error: new Error("cancelled") });
      const participant = store.participant(roomId, handle);
      if (participant?.thread_id) {
        await bb.sdk.threads.stop({ threadId: participant.thread_id }).catch((cause: unknown) => {
          bb.log.warn(`stop @${handle} failed: ${errorMessage(cause)}`);
        });
      }
    }
  }

  function resumeJob(roomId: string): boolean {
    const state = jobs.get(roomId);
    if (state === undefined || state.paused === null || state.resume === null) return false;
    state.resume();
    publish(roomId);
    return true;
  }

  // -- lifecycle events -----------------------------------------------------

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const participant = store.participantByThread(thread.id);
    if (participant === undefined) return;
    const key = pendingKey(participant.room_id, participant.handle);
    const expectation = awaiting.get(key);
    // Only turns the room asked for are posted back; a manual side conversation
    // in the participant's own thread stays there.
    if (expectation === undefined) return;
    let text = lastAssistantText?.trim() ?? "";
    if (text === "") {
      try {
        text = (await bb.sdk.threads.output({ threadId: thread.id })).output?.trim() ?? "";
      } catch (cause) {
        bb.log.warn(`output for ${thread.id} failed: ${errorMessage(cause)}`);
      }
    }
    if (text === "") text = "(no reply text)";
    const roomId = participant.room_id;
    const handles = store.handles(roomId);
    const mentions = mentionsIn(text, handles, participant.handle);
    const parsed = parseReply(text);
    const row = store.appendMessage(roomId, participant.handle, text, mentions, {
      stance: parsed.stance,
      openPoints: parsed.openPoints,
      hopsLeft: expectation.hopsLeft,
      durationMs: Date.now() - expectation.deliveredAt,
    });
    store.q.bumpTurns.run(roomId, participant.handle);
    publish(roomId);
    const reply: ReplyEvent = { text, stance: parsed.stance, openPoints: parsed.openPoints, mentions, seq: row.seq };
    settlePending(roomId, participant.handle, { reply });

    // Hop relay: an addressed participant answers while the budget lasts.
    // Job-driven turns never relay on their own; the job owns turn order.
    if (!expectation.job && expectation.hopsLeft > 0 && mentions.length > 0 && !jobs.has(roomId)) {
      void dispatch(roomId, mentions, addressedInstruction(participant.handle), {
        hopsLeft: expectation.hopsLeft - 1,
        job: false,
        triggeredBy: participant.handle,
      });
    }
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const participant = store.participantByThread(thread.id);
    if (participant === undefined) return;
    const message = error ?? "unknown error";
    if (settlePending(participant.room_id, participant.handle, { error: new Error(message) })) {
      postSystem(participant.room_id, `@${participant.handle} failed: ${message}`);
    }
  });

  bb.events.on("thread.active", ({ thread }) => {
    const participant = store.participantByThread(thread.id);
    if (participant !== undefined) publish(participant.room_id);
  });

  // -- participants: add, brief, compact, reset, remove --------------------

  const BRIEFING_INSTRUCTION = (handle: string, role: string) =>
    [
      `Write a briefing for @${handle}, who is joining this room${role === "none" ? "" : ` as ${role}`}.`,
      "Cover, in under 300 words: what the room is deciding, the decisions made so far with who agreed, the open points, and the current state of any pinned document.",
      "Write it so the newcomer needs nothing else. Do not address the other participants.",
    ].join(" ");

  async function briefNewcomer(room: RoomRow, handle: string, brief: Brief, summarizer: string | null): Promise<void> {
    if (brief === "full") {
      store.q.setLastSeen.run(0, room.id, handle);
      return;
    }
    const max = store.maxSeq(room.id);
    store.q.setLastSeen.run(max, room.id, handle);
    if (brief === "none") return;
    if (summarizer === null) throw new Error("summary briefing needs a summarizer");
    const writer = store.participant(room.id, summarizer);
    if (writer === undefined) throw new Error(`@${summarizer} is not in room`);
    if (writer.thread_id === null) throw new Error(`@${summarizer} has not spoken yet and cannot summarize`);
    const joiner = store.participant(room.id, handle);
    // The newcomer's last_seen_seq stays at `max`, so the summary that lands
    // after it is the first thing relayed to them.
    await deliver(room.id, summarizer, BRIEFING_INSTRUCTION(handle, joiner?.role ?? "none"), { hopsLeft: 0, job: false, triggeredBy: "briefing" });
  }

  async function addParticipant(roomId: string, input: ParticipantInput, brief: Brief, summarizer: string | null): Promise<void> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    if (store.q.participant.get(room.id, input.handle) !== undefined) throw new Error(`handle @${input.handle} is already used in this room`);
    if (input.handle === "user" || input.handle === "system") throw new Error("reserved handle");
    const providers = await providerDirectory();
    if (!providers.has(input.providerId)) throw new Error(`unknown provider ${input.providerId}`);
    store.insertParticipant(room.id, input, 0);
    postSystem(room.id, `@${input.handle} joined (${input.providerId}${input.role && input.role !== "none" ? `, ${input.role}` : ""}).`);
    await briefNewcomer(room, input.handle, brief, summarizer);
  }

  async function releaseThread(threadId: string, label: string): Promise<void> {
    try {
      await bb.sdk.threads.archive({ threadId });
      await bb.sdk.threads.stop({ threadId });
    } catch (cause) {
      bb.log.warn(`release ${label} failed: ${errorMessage(cause)}`);
    }
  }

  async function compactParticipant(roomId: string, handle: string): Promise<void> {
    const participant = store.participant(roomId, handle);
    if (participant?.thread_id == null) throw new Error(`@${handle} has no thread yet`);
    await bb.sdk.threads.compact({ threadId: participant.thread_id });
    postSystem(roomId, `Requested context compaction for @${handle}.`);
  }

  async function resetParticipant(roomId: string, handle: string, brief: Brief, summarizer: string | null): Promise<void> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const participant = store.participant(room.id, handle);
    if (participant === undefined) throw new Error(`@${handle} is not in room`);
    settlePending(room.id, handle, { error: new Error("participant reset") });
    if (participant.thread_id !== null) await releaseThread(participant.thread_id, `@${handle}`);
    store.q.setParticipantThread.run(null, room.id, handle);
    store.q.resetRelayed.run(room.id, handle);
    postSystem(room.id, `@${handle} was reset: a fresh thread starts on the next message to them.`);
    await briefNewcomer(room, handle, brief, summarizer);
  }

  async function removeParticipant(roomId: string, handle: string): Promise<void> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const participant = store.participant(room.id, handle);
    if (participant === undefined) throw new Error(`@${handle} is not in room`);
    const job = jobs.get(room.id);
    if (job !== undefined && job.participants.includes(handle)) throw new Error("cancel the running job first");
    settlePending(room.id, handle, { error: new Error("participant removed") });
    if (participant.thread_id !== null) await releaseThread(participant.thread_id, `@${handle}`);
    store.q.removeParticipant.run(Date.now(), room.id, handle);
    if (room.doc_owner === handle) store.q.updateRoom.run(room.title, room.doc_path, null, room.default_hops, Date.now(), room.id);
    postSystem(room.id, `@${handle} left the room.`);
  }

  // -- read models ----------------------------------------------------------

  async function environmentInfo(room: RoomRow): Promise<{ path: string | null; hostId: string | null }> {
    if (room.environment_id === null) return { path: null, hostId: null };
    try {
      const env = await bb.sdk.environments.get({ environmentId: room.environment_id });
      return { path: env.path, hostId: env.hostId };
    } catch {
      return { path: null, hostId: null };
    }
  }

  async function roomDetail(roomId: string): Promise<RoomDetail> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const rows = store.q.allParticipants.all(room.id);
    const participants = await Promise.all(
      rows.map(async (row): Promise<Participant> => {
        let status: string | null = null;
        if (row.thread_id !== null && row.removed_at === null) {
          try {
            status = (await bb.sdk.threads.get({ threadId: row.thread_id })).status;
          } catch {
            status = null;
          }
        }
        const last = store.q.lastMessageBy.get(room.id, row.handle, 0);
        return {
          handle: row.handle,
          providerId: row.provider_id,
          model: row.model,
          reasoningLevel: row.reasoning_level,
          role: isRole(row.role) ? row.role : "none",
          roleInstructions: row.role_instructions,
          threadId: row.thread_id,
          lastSeenSeq: row.last_seen_seq,
          status,
          turns: row.turns,
          relayedChars: row.relayed_chars,
          lastStance: last !== undefined && isStance(last.stance) ? last.stance : null,
          removed: row.removed_at !== null,
        };
      }),
    );
    const env = await environmentInfo(room);
    return {
      room: toRoom(room),
      participants,
      messages: store.messages(room.id).map(toMessage),
      job: jobView(room.id),
      workspacePath: env.path,
      hostId: env.hostId,
    };
  }

  async function roomChanges(roomId: string): Promise<{ files: ChangedFile[]; note: string | null }> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    if (room.environment_id === null) return { files: [], note: "No workspace yet." };
    try {
      const result = await bb.sdk.environments.diffFiles({ environmentId: room.environment_id, target: "uncommitted" });
      if (result.outcome !== "available") {
        return { files: [], note: result.outcome === "not_applicable" ? result.message : result.failure.message };
      }
      return {
        files: result.files.slice(0, 100).map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          changeKind: file.changeKind,
        })),
        note: result.truncated ? "Diff truncated." : null,
      };
    } catch (cause) {
      return { files: [], note: errorMessage(cause) };
    }
  }

  async function docRead(roomId: string): Promise<DocRead> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    if (room.doc_path === null) return { path: null, exists: false, content: "", sha256: null, note: "No pinned document." };
    const env = await environmentInfo(room);
    if (env.path === null || env.hostId === null) {
      return { path: room.doc_path, exists: false, content: "", sha256: null, note: "The workspace resolves after the first participant is tagged." };
    }
    try {
      const file = await bb.sdk.files.read({ hostId: env.hostId, path: joinPath(env.path, room.doc_path), rootPath: env.path });
      const content = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      return { path: room.doc_path, exists: true, content, sha256: file.sha256, note: null };
    } catch (cause) {
      return { path: room.doc_path, exists: false, content: "", sha256: null, note: errorMessage(cause) };
    }
  }

  async function docCreate(roomId: string): Promise<DocRead> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    if (room.doc_path === null) throw new Error("pin a document path first");
    const env = await environmentInfo(room);
    if (env.path === null || env.hostId === null) throw new Error("the workspace resolves after the first participant is tagged");
    const owner = room.doc_owner === null ? "the user" : `@${room.doc_owner}`;
    const template = [
      `# ${room.title}`,
      "",
      `Working document for Roundtable room ${room.id}. Owner: ${owner}.`,
      "",
      "## Decisions",
      "",
      "1. ",
      "",
      "## Open points",
      "",
      "- ",
      "",
      "## Changes since last version",
      "",
      "- Created.",
      "",
    ].join("\n");
    const result = await bb.sdk.files.write({
      hostId: env.hostId,
      path: joinPath(env.path, room.doc_path),
      rootPath: env.path,
      content: template,
      createParents: true,
      expectedSha256: null,
    });
    if (result.outcome === "conflict") throw new Error("the document already exists");
    postSystem(room.id, `Pinned document created at ${room.doc_path}.`);
    return docRead(room.id);
  }

  function roomSummaries(): RoomSummary[] {
    return store.rooms().map((row) => ({
      ...toRoom(row),
      handles: store.handles(row.id),
      messageCount: store.q.messageCount.get(row.id)?.n ?? 0,
      lastAuthor: store.q.lastMessage.get(row.id)?.author ?? null,
      jobKind: jobs.get(row.id)?.kind ?? null,
    }));
  }

  async function contextOptions(): Promise<ContextOptions> {
    const [projects, providers] = await Promise.all([
      bb.sdk.projects.list({ includePersonal: true }),
      bb.sdk.providers.list(),
    ]);
    const options = await Promise.all(
      providers.map(async (provider): Promise<ProviderOption> => {
        let models: ProviderOption["models"] = [];
        if (provider.available) {
          try {
            const result = await bb.sdk.providers.models({ providerId: provider.id });
            models = result.models
              .filter((m) => (m.routeProviderId ?? provider.id) === provider.id)
              .map((m) => ({ model: m.model, displayName: m.displayName, isDefault: m.isDefault }));
          } catch (cause) {
            bb.log.warn(`models for ${provider.id} failed: ${errorMessage(cause)}`);
          }
        }
        return {
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
          models,
          reasoningLevels: (provider.reasoningLevels ?? []).map((level) => level.id),
        };
      }),
    );
    return {
      projects: projects.map((project) => ({ id: project.id, name: project.name, kind: project.kind })),
      providers: options,
    };
  }

  async function archiveRoom(roomId: string): Promise<void> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    await cancelJob(room.id);
    for (const participant of store.participants(room.id)) {
      settlePending(room.id, participant.handle, { error: new Error("room archived") });
      if (participant.thread_id !== null) await releaseThread(participant.thread_id, `@${participant.handle}`);
    }
    store.q.archiveRoom.run(Date.now(), room.id);
    publish(room.id);
  }

  interface CreateRoomInput {
    title: string;
    projectId: string;
    environmentId?: string | null;
    participants: ParticipantInput[];
    docPath?: string | null;
    docOwner?: string | null;
    defaultHops?: number;
  }

  async function createRoom(input: CreateRoomInput): Promise<Room> {
    const handles = input.participants.map((p) => p.handle);
    if (uniq(handles).length !== handles.length) throw new Error("participant handles must be unique");
    if (handles.includes("user") || handles.includes("system")) throw new Error("\"user\" and \"system\" are reserved handles");
    const docOwner = input.docOwner ?? null;
    if (docOwner !== null && !handles.includes(docOwner)) throw new Error(`document owner @${docOwner} is not a participant`);
    const providers = await providerDirectory();
    for (const p of input.participants) {
      if (!providers.has(p.providerId)) throw new Error(`unknown provider ${p.providerId}`);
    }
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    if (!projects.some((project) => project.id === input.projectId)) throw new Error(`unknown project ${input.projectId}`);
    const docPath = input.docPath?.trim() ? input.docPath.trim() : null;
    const row = store.createRoom({
      title: input.title,
      projectId: input.projectId,
      environmentId: input.environmentId ?? null,
      participants: input.participants,
      docPath,
      docOwner: docPath === null ? null : docOwner,
      defaultHops: input.defaultHops ?? 0,
    });
    publish(row.id);
    return toRoom(row);
  }

  function updateRoom(input: { roomId: string; title?: string; docPath?: string | null; docOwner?: string | null; defaultHops?: number }): Room {
    const room = store.room(input.roomId);
    if (room === undefined) throw new Error(`room ${input.roomId} not found`);
    const title = input.title ?? room.title;
    const docPath = input.docPath === undefined ? room.doc_path : (input.docPath?.trim() ? input.docPath.trim() : null);
    let docOwner = input.docOwner === undefined ? room.doc_owner : input.docOwner;
    if (docOwner !== null && !store.handles(room.id).includes(docOwner)) throw new Error(`@${docOwner} is not a participant`);
    if (docPath === null) docOwner = null;
    const defaultHops = input.defaultHops ?? room.default_hops;
    store.q.updateRoom.run(title, docPath, docOwner, defaultHops, Date.now(), room.id);
    if (docPath !== room.doc_path || docOwner !== room.doc_owner) {
      postSystem(room.id, docPath === null ? "Pinned document removed." : `Pinned document: ${docPath}${docOwner === null ? "" : `, owned by @${docOwner}`}.`);
    }
    publish(room.id);
    const fresh = store.room(room.id);
    if (fresh === undefined) throw new Error("room vanished");
    return toRoom(fresh);
  }

  async function roomForThread(threadId: string): Promise<RoomForThread> {
    const thread = await bb.sdk.threads.get({ threadId });
    const room = thread.environmentId === null ? undefined : store.q.roomByEnvironment.get(thread.environmentId);
    return {
      room: room === undefined ? null : toRoom(room),
      projectId: thread.projectId,
      environmentId: thread.environmentId,
      title: thread.title ?? thread.titleFallback ?? "Roundtable",
    };
  }

  async function postAndDispatch(roomId: string, author: string, text: string, tags: readonly string[], hops: number): Promise<{ seq: number; dispatched: string[] }> {
    const job = jobs.get(roomId);
    if (job !== undefined && job.paused !== null) {
      // The user's answer resumes the paused job; the asker gets it in its delta.
      const posted = postFrom(roomId, author, text, [job.paused.handle], hops);
      resumeJob(roomId);
      return { seq: posted.seq, dispatched: [] };
    }
    const posted = postFrom(roomId, author, text, tags, hops);
    const instruction = author === "user" ? USER_TAG_INSTRUCTION : addressedInstruction(author);
    const dispatched = await dispatch(roomId, posted.tags, instruction, { hopsLeft: hops, job: false, triggeredBy: author });
    return { seq: posted.seq, dispatched };
  }

  bb.rpc.register(rpcContract, {
    rooms_list: () => ({ rooms: roomSummaries() }),
    rooms_create: async (input) => ({ room: await createRoom(input) }),
    rooms_update: (input) => ({ room: updateRoom(input) }),
    rooms_get: ({ roomId }) => roomDetail(roomId),
    rooms_changes: ({ roomId }) => roomChanges(roomId),
    rooms_post: async ({ roomId, text, tags, hops }) => {
      const room = store.room(roomId);
      if (room === undefined) throw new Error(`room ${roomId} not found`);
      return postAndDispatch(room.id, "user", text, tags, hops ?? room.default_hops);
    },
    rooms_start_rounds: ({ roomId, text, participants, rounds }) => {
      startRounds(roomId, text, participants, rounds, "user");
      return { ok: true as const };
    },
    rooms_ask_all: ({ roomId, text, participants, synthesizer }) => {
      startAskAll(roomId, text, participants, synthesizer ?? null, "user");
      return { ok: true as const };
    },
    rooms_cancel_job: async ({ roomId }) => {
      await cancelJob(roomId);
      return { ok: true as const };
    },
    rooms_resume_job: ({ roomId }) => {
      if (!resumeJob(roomId)) throw new Error("no paused job in this room");
      return { ok: true as const };
    },
    rooms_archive: async ({ roomId }) => {
      await archiveRoom(roomId);
      return { ok: true as const };
    },
    rooms_add_participant: async ({ roomId, participant, brief, summarizer }) => {
      await addParticipant(roomId, participant, brief, summarizer ?? null);
      return { ok: true as const };
    },
    rooms_participant_compact: async ({ roomId, handle }) => {
      await compactParticipant(roomId, handle);
      return { ok: true as const };
    },
    rooms_participant_reset: async ({ roomId, handle, brief, summarizer }) => {
      await resetParticipant(roomId, handle, brief, summarizer ?? null);
      return { ok: true as const };
    },
    rooms_participant_remove: async ({ roomId, handle }) => {
      await removeParticipant(roomId, handle);
      return { ok: true as const };
    },
    rooms_doc_read: ({ roomId }) => docRead(roomId),
    rooms_doc_create: ({ roomId }) => docCreate(roomId),
    rooms_for_thread: ({ threadId }) => roomForThread(threadId),
    context_options: () => contextOptions(),
  });

  // -- CLI ------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb roundtable list [--json]",
    "  bb roundtable show <room> [--since <seq>] [--json]",
    "  bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code:planner,codex=codex:reviewer] [--doc <path> --owner <handle>] [--hops N]",
    "  bb roundtable say <room> [--to a,b] [--hops N] [--as <handle>] <message...>",
    "  bb roundtable ask <room> --to a,b [--synth <handle>] <message...>",
    "  bb roundtable rounds <room> --between a,b [--rounds N] <message...>",
    "  bb roundtable add <room> <handle>=<provider>[:role] [--brief full|summary|none] [--summarizer <handle>]",
    "  bb roundtable doc <room> --path <path> [--owner <handle>]",
    "  bb roundtable compact|reset|remove <room> <handle>",
    "  bb roundtable resume|cancel|archive <room>",
    "",
    "<room> is a room id or its exact title. Inside a participant thread, `say`",
    "posts as that participant. @handle mentions tag participants even without",
    "--to. --hops lets the addressed agents relay to each other that many times.",
  ].join("\n");

  interface ParsedArgs {
    positional: string[];
    flags: Map<string, string | true>;
  }
  const VALUE_FLAGS = new Set(["to", "as", "since", "title", "project", "participants", "between", "rounds", "hops", "synth", "brief", "summarizer", "path", "owner", "doc", "role"]);
  function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) flags.set(name, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) flags.set(name, argv[++i]);
      else flags.set(name, true);
    }
    return { positional, flags };
  }
  const flagString = (flags: ParsedArgs["flags"], name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const splitList = (value: string | undefined): string[] =>
    value === undefined ? [] : value.split(",").map((v) => v.trim()).filter((v) => v !== "");

  function parseParticipantSpec(entry: string): ParticipantInput | null {
    // handle=provider[=model][:role]
    const [head, role] = entry.split(":");
    const [handle, providerId, model] = head.split("=");
    if (!handle || !providerId || !HANDLE_RE.test(handle)) return null;
    if (role !== undefined && !isRole(role)) return null;
    return { handle, providerId, ...(model ? { model } : {}), ...(role ? { role: role as Role } : {}) };
  }

  const formatRoomLine = (room: RoomSummary): string =>
    `${room.id}  ${room.title}  [${room.handles.map((h) => `@${h}`).join(" ")}]  ${room.messageCount} msg${room.jobKind ? `  (${room.jobKind} running)` : ""}`;

  bb.cli.register({
    name: "roundtable",
    summary: "Group chat rooms shared by several agents: read the room, post, tag participants, ask all, run rounds",
    commands: [
      { name: "list", summary: "List rooms", usage: "bb roundtable list [--json]" },
      { name: "show", summary: "Print a room transcript", usage: "bb roundtable show <room> [--since <seq>] [--json]" },
      { name: "create", summary: "Create a room", usage: "bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code:planner,codex=codex:reviewer] [--doc <path> --owner <handle>] [--hops N]" },
      { name: "say", summary: "Post to a room and optionally tag participants", usage: "bb roundtable say <room> [--to a,b] [--hops N] [--as <handle>] <message...>" },
      { name: "ask", summary: "Ask several participants in parallel, optionally synthesize", usage: "bb roundtable ask <room> --to a,b [--synth <handle>] <message...>" },
      { name: "rounds", summary: "Run bounded back-and-forth rounds", usage: "bb roundtable rounds <room> --between a,b [--rounds N] <message...>" },
      { name: "add", summary: "Add a participant with a briefing", usage: "bb roundtable add <room> <handle>=<provider>[:role] [--brief full|summary|none] [--summarizer <handle>]" },
      { name: "doc", summary: "Pin the room's working document", usage: "bb roundtable doc <room> --path <path> [--owner <handle>]" },
      { name: "compact", summary: "Compact a participant's context", usage: "bb roundtable compact <room> <handle>" },
      { name: "reset", summary: "Give a participant a fresh thread", usage: "bb roundtable reset <room> <handle> [--brief full|summary|none] [--summarizer <handle>]" },
      { name: "remove", summary: "Remove a participant", usage: "bb roundtable remove <room> <handle>" },
      { name: "resume", summary: "Resume a job paused on need-info", usage: "bb roundtable resume <room>" },
      { name: "cancel", summary: "Cancel the running job", usage: "bb roundtable cancel <room>" },
      { name: "archive", summary: "Archive a room and stop its participant threads", usage: "bb roundtable archive <room>" },
    ],
    async run(argv, ctx) {
      const { positional, flags } = parseArgs(argv);
      const json = flags.has("json");
      const [command, ...rest] = positional;
      const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const fail = (text: string) => ({ exitCode: 1, stderr: text });
      const resolveRoom = (ref: string | undefined): RoomRow | undefined => (ref === undefined ? undefined : store.room(ref));
      const speakerFor = (room: RoomRow): string => {
        const explicit = flagString(flags, "as");
        if (explicit !== undefined) return explicit;
        const speaker = ctx.threadId === undefined ? undefined : store.participantByThread(ctx.threadId);
        return speaker !== undefined && speaker.room_id === room.id ? speaker.handle : "user";
      };
      const briefFor = (): Brief => {
        const value = flagString(flags, "brief") ?? "summary";
        if (value === "full" || value === "summary" || value === "none") return value;
        throw new Error("--brief must be full, summary, or none");
      };

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const rooms = roomSummaries();
            return ok(rooms, rooms.length === 0 ? "No rooms." : rooms.map(formatRoomLine).join("\n"));
          }
          case "show": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}". Run "bb roundtable list".`);
            const since = Number(flagString(flags, "since") ?? "0");
            const detail = await roomDetail(room.id);
            const messages = detail.messages.filter((m) => m.seq > (Number.isFinite(since) ? since : 0));
            const roster = detail.participants
              .filter((p) => !p.removed)
              .map((p) => `@${p.handle}=${p.providerId}${p.role !== "none" ? `/${p.role}` : ""}${p.status ? `:${p.status}` : ""}`)
              .join(", ");
            const header = [
              `${room.title} (${room.id}) — ${roster}`,
              room.doc_path ? `Pinned document: ${room.doc_path}${room.doc_owner ? ` (owner @${room.doc_owner})` : ""}` : null,
              detail.job ? `Job: ${detail.job.kind} turn ${detail.job.turn}/${detail.job.totalTurns}${detail.job.paused ? ` paused on @${detail.job.paused.handle}` : ""}` : null,
            ].filter((line): line is string => line !== null).join("\n");
            const body = messages.length === 0
              ? "(no messages)"
              : messages.map((m) => `### ${authorLabel(m.author)} (#${m.seq})${m.stance ? ` [${m.stance}]` : ""}\n${m.text}`).join("\n\n");
            return ok({ ...detail, messages }, `${header}\n\n${body}`);
          }
          case "create": {
            const title = flagString(flags, "title") ?? rest.join(" ").trim();
            if (title === "") return fail("create needs --title <title>");
            let projectId = flagString(flags, "project") ?? ctx.projectId;
            if (projectId === undefined) {
              const projects = await bb.sdk.projects.list({ includePersonal: true });
              projectId = projects.find((p) => p.kind !== "standard")?.id ?? projects[0]?.id;
            }
            if (projectId === undefined) return fail("no project available; pass --project <id>");
            const spec = flagString(flags, "participants") ?? "claude=claude-code,codex=codex";
            const participants: ParticipantInput[] = [];
            for (const entry of splitList(spec)) {
              const parsed = parseParticipantSpec(entry);
              if (parsed === null) return fail(`bad participant "${entry}"; use handle=provider[=model][:role]`);
              participants.push(parsed);
            }
            const hops = flagString(flags, "hops");
            const room = await createRoom({
              title,
              projectId,
              participants,
              docPath: flagString(flags, "doc") ?? null,
              docOwner: flagString(flags, "owner") ?? null,
              defaultHops: hops === undefined ? 0 : Number(hops),
            });
            return ok(room, `Created room ${room.id} "${room.title}" with ${participants.map((p) => `@${p.handle}`).join(", ")}`);
          }
          case "say": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const text = rest.slice(1).join(" ").trim();
            if (text === "") return fail("say needs a message");
            const author = speakerFor(room);
            const hopsFlag = flagString(flags, "hops");
            let hops = hopsFlag === undefined ? room.default_hops : Number(hopsFlag);
            if (author !== "user" && hopsFlag === undefined) {
              // An agent relaying mid-turn inherits what is left of its own budget.
              hops = Math.max(0, (awaiting.get(pendingKey(room.id, author))?.hopsLeft ?? 0) - 1);
            }
            if (!Number.isInteger(hops) || hops < 0 || hops > 8) return fail("--hops must be 0..8");
            const result = await postAndDispatch(room.id, author, text, splitList(flagString(flags, "to")), hops);
            return ok({ ...result, author }, `Posted #${result.seq} as ${authorLabel(author)}${result.dispatched.length ? `; tagged ${result.dispatched.map((h) => `@${h}`).join(", ")}` : ""}`);
          }
          case "ask": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const targets = splitList(flagString(flags, "to"));
            const text = rest.slice(1).join(" ").trim();
            if (targets.length === 0) return fail("ask needs --to a,b");
            if (text === "") return fail("ask needs a question");
            startAskAll(room.id, text, targets, flagString(flags, "synth") ?? null, speakerFor(room));
            return ok({ ok: true }, `Asking ${targets.map((h) => `@${h}`).join(", ")}`);
          }
          case "rounds": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const between = splitList(flagString(flags, "between"));
            const total = Number(flagString(flags, "rounds") ?? "3");
            const text = rest.slice(1).join(" ").trim();
            if (between.length < 2) return fail("rounds needs --between a,b");
            if (!Number.isInteger(total) || total < 1 || total > 20) return fail("--rounds must be 1..20");
            if (text === "") return fail("rounds needs a kickoff message");
            startRounds(room.id, text, between, total, speakerFor(room));
            return ok({ ok: true }, `Started ${total} round(s) between ${between.map((h) => `@${h}`).join(", ")}`);
          }
          case "add": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const parsed = rest[1] === undefined ? null : parseParticipantSpec(rest[1]);
            if (parsed === null) return fail("add needs <handle>=<provider>[:role]");
            const brief = briefFor();
            let summarizer = flagString(flags, "summarizer") ?? null;
            if (brief === "summary" && summarizer === null) {
              summarizer = store.participants(room.id).find((p) => p.thread_id !== null)?.handle ?? null;
              if (summarizer === null) return fail("no participant has spoken yet; use --brief full or none");
            }
            await addParticipant(room.id, parsed, brief, summarizer);
            return ok({ ok: true }, `Added @${parsed.handle} (${brief} briefing${summarizer ? ` by @${summarizer}` : ""}).`);
          }
          case "doc": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const path = flagString(flags, "path");
            if (path === undefined) return fail("doc needs --path <path>");
            const updated = updateRoom({ roomId: room.id, docPath: path, docOwner: flagString(flags, "owner") ?? null });
            return ok(updated, `Pinned ${updated.docPath}${updated.docOwner ? ` (owner @${updated.docOwner})` : ""}.`);
          }
          case "compact":
          case "reset":
          case "remove": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const handle = rest[1];
            if (handle === undefined) return fail(`${command} needs <handle>`);
            if (command === "compact") await compactParticipant(room.id, handle);
            else if (command === "remove") await removeParticipant(room.id, handle);
            else {
              const brief = briefFor();
              let summarizer = flagString(flags, "summarizer") ?? null;
              if (brief === "summary" && summarizer === null) {
                summarizer = store.participants(room.id).find((p) => p.thread_id !== null && p.handle !== handle)?.handle ?? null;
                if (summarizer === null) return fail("no other participant can summarize; use --brief full or none");
              }
              await resetParticipant(room.id, handle, brief, summarizer);
            }
            return ok({ ok: true }, `${command} @${handle}: done.`);
          }
          case "resume": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            return resumeJob(room.id) ? ok({ ok: true }, "Resumed.") : fail("no paused job in this room");
          }
          case "cancel": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            await cancelJob(room.id);
            return ok({ ok: true }, "Cancelled.");
          }
          case "archive": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            await archiveRoom(room.id);
            return ok({ ok: true }, `Archived ${room.id}.`);
          }
          default:
            return fail(usage);
        }
      } catch (cause) {
        return fail(errorMessage(cause));
      }
    },
  });

  bb.onDispose(() => {
    for (const state of jobs.values()) state.controller.abort();
    jobs.clear();
    for (const list of pending.values()) {
      for (const entry of list) entry.reject(new Error("plugin disposed"));
    }
    pending.clear();
    awaiting.clear();
    bb.log.info("disposed");
  });

  bb.log.info("loaded");
}
