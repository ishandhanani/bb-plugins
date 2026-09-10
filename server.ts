// bb-plugin-roundtable — server entry.
//
// A room is a shared transcript owned by this plugin. Each participant is an
// ordinary bb thread (one per agent provider) that shares the room's
// environment. When a participant is tagged, the plugin relays every room
// message it has not seen yet, plus an instruction, into that thread. The
// participant's final reply is captured on `thread.idle` and posted back to
// the room. Rounds run that relay back and forth between participants for a
// bounded number of turns.
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

const participantInputSchema = z.object({
  handle: handleSchema,
  providerId: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  reasoningLevel: reasoningSchema.nullable().optional(),
});
export type ParticipantInput = z.infer<typeof participantInputSchema>;

const participantSchema = z.object({
  handle: z.string(),
  providerId: z.string(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  threadId: z.string().nullable(),
  lastSeenSeq: z.number(),
  status: z.string().nullable(),
});
export type Participant = z.infer<typeof participantSchema>;

const messageSchema = z.object({
  seq: z.number(),
  author: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
  createdAt: z.number(),
});
export type Message = z.infer<typeof messageSchema>;

const roomSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Room = z.infer<typeof roomSchema>;

const roomSummarySchema = roomSchema.extend({
  handles: z.array(z.string()),
  messageCount: z.number(),
  lastAuthor: z.string().nullable(),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;

const roundsSchema = z
  .object({
    total: z.number(),
    round: z.number(),
    participants: z.array(z.string()),
    current: z.string().nullable(),
    startedAt: z.number(),
  })
  .nullable();
export type Rounds = z.infer<typeof roundsSchema>;

const roomDetailSchema = z.object({
  room: roomSchema,
  participants: z.array(participantSchema),
  messages: z.array(messageSchema),
  rounds: roundsSchema,
  workspacePath: z.string().nullable(),
});
export type RoomDetail = z.infer<typeof roomDetailSchema>;

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

const okSchema = z.object({ ok: z.literal(true) });

export const rpcContract = defineRpcContract({
  rooms_list: {
    input: z.null(),
    output: z.object({ rooms: z.array(roomSummarySchema) }),
  },
  rooms_create: {
    input: z.object({
      title: z.string().trim().min(1).max(120),
      projectId: z.string().min(1),
      participants: z.array(participantInputSchema).min(1).max(8),
    }),
    output: z.object({ room: roomSchema }),
  },
  rooms_get: {
    input: z.object({ roomId: z.string() }),
    output: roomDetailSchema,
  },
  rooms_post: {
    input: z.object({
      roomId: z.string(),
      text: z.string().trim().min(1).max(20_000),
      tags: z.array(handleSchema).max(8),
    }),
    output: z.object({ seq: z.number(), dispatched: z.array(z.string()) }),
  },
  rooms_start_rounds: {
    input: z.object({
      roomId: z.string(),
      text: z.string().trim().min(1).max(20_000),
      participants: z.array(handleSchema).min(2).max(8),
      rounds: z.number().int().min(1).max(20),
    }),
    output: okSchema,
  },
  rooms_cancel_rounds: {
    input: z.object({ roomId: z.string() }),
    output: okSchema,
  },
  rooms_archive: {
    input: z.object({ roomId: z.string() }),
    output: okSchema,
  },
  context_options: {
    input: z.null(),
    output: contextOptionsSchema,
  },
});

/** Realtime channel app.tsx listens on; payload is `{ roomId }`. */
export const ROOM_CHANGED = "room-changed";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT,
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
     thread_id TEXT,
     last_seen_seq INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, handle)
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     room_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     author TEXT NOT NULL,
     text TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
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
}
interface MessageRow {
  room_id: string;
  seq: number;
  author: string;
  text: string;
  tags: string;
  created_at: number;
}

function createStore(db: Database.Database) {
  const q = {
    roomById: db.prepare<[string], RoomRow>(
      `SELECT * FROM rooms WHERE id = ? AND archived_at IS NULL`,
    ),
    roomByTitle: db.prepare<[string], RoomRow>(
      `SELECT * FROM rooms WHERE lower(title) = lower(?) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
    ),
    rooms: db.prepare<[], RoomRow>(
      `SELECT * FROM rooms WHERE archived_at IS NULL ORDER BY updated_at DESC`,
    ),
    insertRoom: db.prepare<[string, string, string, number, number]>(
      `INSERT INTO rooms (id, title, project_id, environment_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
    ),
    touchRoom: db.prepare<[number, string]>(
      `UPDATE rooms SET updated_at = ? WHERE id = ?`,
    ),
    setRoomEnvironment: db.prepare<[string, string]>(
      `UPDATE rooms SET environment_id = ? WHERE id = ? AND environment_id IS NULL`,
    ),
    archiveRoom: db.prepare<[number, string]>(
      `UPDATE rooms SET archived_at = ? WHERE id = ?`,
    ),
    participants: db.prepare<[string], ParticipantRow>(
      `SELECT * FROM participants WHERE room_id = ? ORDER BY created_at ASC`,
    ),
    participant: db.prepare<[string, string], ParticipantRow>(
      `SELECT * FROM participants WHERE room_id = ? AND handle = ?`,
    ),
    participantByThread: db.prepare<[string], ParticipantRow>(
      `SELECT * FROM participants WHERE thread_id = ?`,
    ),
    insertParticipant: db.prepare<
      [string, string, string, string | null, string | null, number]
    >(
      `INSERT INTO participants (room_id, handle, provider_id, model, reasoning_level, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    setParticipantThread: db.prepare<[string, string, string]>(
      `UPDATE participants SET thread_id = ? WHERE room_id = ? AND handle = ?`,
    ),
    setLastSeen: db.prepare<[number, string, string]>(
      `UPDATE participants SET last_seen_seq = ? WHERE room_id = ? AND handle = ?`,
    ),
    messages: db.prepare<[string, number], MessageRow>(
      `SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC`,
    ),
    lastMessage: db.prepare<[string], MessageRow>(
      `SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1`,
    ),
    messageCount: db.prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE room_id = ?`,
    ),
    nextSeq: db.prepare<[string], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE room_id = ?`,
    ),
    insertMessage: db.prepare<
      [string, number, string, string, string, number]
    >(
      `INSERT INTO messages (room_id, seq, author, text, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  };

  const appendMessage = db.transaction(
    (roomId: string, author: string, text: string, tags: string[]): MessageRow => {
      const seq = q.nextSeq.get(roomId)?.seq ?? 1;
      const createdAt = Date.now();
      const tagsJson = JSON.stringify(tags);
      q.insertMessage.run(roomId, seq, author, text, tagsJson, createdAt);
      q.touchRoom.run(createdAt, roomId);
      return { room_id: roomId, seq, author, text, tags: tagsJson, created_at: createdAt };
    },
  );

  const createRoom = db.transaction(
    (title: string, projectId: string, participants: ParticipantInput[]): RoomRow => {
      const id = randomBytes(5).toString("hex");
      const now = Date.now();
      q.insertRoom.run(id, title, projectId, now, now);
      for (const p of participants) {
        q.insertParticipant.run(
          id,
          p.handle,
          p.providerId,
          p.model ?? null,
          p.reasoningLevel ?? null,
          now,
        );
      }
      return {
        id,
        title,
        project_id: projectId,
        environment_id: null,
        created_at: now,
        updated_at: now,
        archived_at: null,
      };
    },
  );

  return {
    q,
    appendMessage,
    createRoom,
    room(id: string): RoomRow | undefined {
      return q.roomById.get(id) ?? q.roomByTitle.get(id);
    },
    rooms(): RoomRow[] {
      return q.rooms.all();
    },
    participants(roomId: string): ParticipantRow[] {
      return q.participants.all(roomId);
    },
    participant(roomId: string, handle: string): ParticipantRow | undefined {
      return q.participant.get(roomId, handle);
    },
    participantByThread(threadId: string): ParticipantRow | undefined {
      return q.participantByThread.get(threadId);
    },
    messages(roomId: string, afterSeq = 0): MessageRow[] {
      return q.messages.all(roomId, afterSeq);
    },
  };
}
type Store = ReturnType<typeof createStore>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    environmentId: row.environment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    tags = [];
  }
  return {
    seq: row.seq,
    author: row.author,
    text: row.text,
    tags,
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

const SETTLED_RE = /^\W*settled\W*$/i;
function isSettled(reply: string): boolean {
  const lines = reply
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.at(-1);
  return last !== undefined && SETTLED_RE.test(last);
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface PendingTurn {
  resolve(text: string): void;
  reject(error: Error): void;
}

interface RoundsState {
  roomId: string;
  participants: string[];
  total: number;
  round: number;
  current: string | null;
  startedAt: number;
  controller: AbortController;
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

  /** Promises awaiting a reply, keyed by `${roomId}/${handle}` (rounds only). */
  const pending = new Map<string, PendingTurn[]>();
  /** Participants the room expects a reply from; set by every delivery. */
  const awaiting = new Set<string>();
  const rounds = new Map<string, RoundsState>();
  const spawnLocks = new Map<string, Promise<unknown>>();

  const pendingKey = (roomId: string, handle: string) => `${roomId}/${handle}`;

  function publish(roomId: string): void {
    bb.realtime.publish(ROOM_CHANGED, { roomId });
  }

  function postSystem(roomId: string, text: string): void {
    store.appendMessage(roomId, "system", text, []);
    publish(roomId);
  }

  function waitForReply(roomId: string, handle: string, signal?: AbortSignal): Promise<string> {
    const key = pendingKey(roomId, handle);
    return new Promise<string>((resolve, reject) => {
      const entry: PendingTurn = {
        resolve: (text) => {
          cleanup();
          resolve(text);
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

  function settlePending(roomId: string, handle: string, outcome: { text: string } | { error: Error }): boolean {
    const key = pendingKey(roomId, handle);
    const expected = awaiting.delete(key);
    const list = pending.get(key);
    if (list === undefined || list.length === 0) return expected;
    pending.delete(key);
    for (const entry of list) {
      if ("text" in outcome) entry.resolve(outcome.text);
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

  function introFor(room: RoomRow, participant: ParticipantRow, others: readonly ParticipantRow[]): string {
    const roster = others.length === 0
      ? "no other agents yet"
      : others.map((other) => `@${other.handle} (${other.provider_id})`).join(", ");
    return [
      `You are @${participant.handle} in "${room.title}", a Roundtable room shared by the user and other agents: ${roster}.`,
      "",
      "How the room works:",
      "- Room messages are relayed to you in order with their author. \"user\" is the human. \"@name\" is another agent.",
      `- Your final reply is posted to the room verbatim as @${participant.handle}. Write for the room. Do not restate the relayed messages or narrate the relay.`,
      "- Be concrete. Disagree with specifics. Agree briefly. Keep it short unless the user asks for detail.",
      "- Do not modify files unless the user explicitly asks you to in this room. Reading files and running read-only commands to check claims is encouraged. All participants share this workspace.",
      `- To read the room: bb roundtable show ${room.id}. To pull another agent in mid-turn: bb roundtable say ${room.id} --to <handle> "<message>". Your final reply is still posted.`,
    ].join("\n");
  }

  /**
   * Relay everything `participant` has not seen, plus `instruction`, into its
   * thread (spawning the thread on first contact). Resolves once the message
   * is accepted; the reply arrives through `thread.idle`.
   */
  async function deliver(roomId: string, handle: string, instruction: string): Promise<void> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const participant = store.participant(room.id, handle);
    if (participant === undefined) throw new Error(`@${handle} is not in room ${room.id}`);
    const all = store.participants(room.id);
    const others = all.filter((other) => other.handle !== handle);
    const unseen = store
      .messages(room.id, participant.last_seen_seq)
      .filter((row) => row.author !== handle);
    const deliveredUpTo = Math.max(
      participant.last_seen_seq,
      ...store.messages(room.id, participant.last_seen_seq).map((row) => row.seq),
    );

    const sections: string[] = [];
    const firstContact = participant.thread_id === null;
    if (firstContact) sections.push(introFor(room, participant, others));
    if (unseen.length > 0) sections.push(`New messages in the room:\n\n${formatTranscript(unseen)}`);
    sections.push(instruction);
    const text = sections.join("\n\n");

    // Mark the reply as expected before the provider can possibly finish.
    const key = pendingKey(room.id, handle);
    awaiting.add(key);
    try {
      await sendOrSpawn(room, participant, text);
    } catch (cause) {
      if (!pending.has(key)) awaiting.delete(key);
      throw cause;
    }
    store.q.setLastSeen.run(deliveredUpTo, room.id, handle);
    publish(room.id);
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

  /** Deliver to each tagged participant in order; failures become room system messages. */
  async function dispatch(roomId: string, handles: readonly string[], instruction: string): Promise<string[]> {
    const dispatched: string[] = [];
    for (const handle of handles) {
      try {
        await deliver(roomId, handle, instruction);
        dispatched.push(handle);
      } catch (cause) {
        const message = errorMessage(cause);
        bb.log.warn(`deliver to @${handle} in ${roomId} failed: ${message}`);
        postSystem(roomId, `Could not reach @${handle}: ${message}`);
      }
    }
    return dispatched;
  }

  function postFrom(roomId: string, author: string, text: string, explicitTags: readonly string[]): { seq: number; tags: string[] } {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const handles = store.participants(room.id).map((p) => p.handle);
    const tags = uniq([
      ...explicitTags.filter((tag) => handles.includes(tag) && tag !== author),
      ...mentionsIn(text, handles, author),
    ]);
    const row = store.appendMessage(room.id, author, text, tags);
    publish(room.id);
    return { seq: row.seq, tags };
  }

  // -- rounds ---------------------------------------------------------------

  function startRounds(roomId: string, text: string, participants: string[], total: number, author: string): void {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    if (rounds.has(room.id)) throw new Error("rounds are already running in this room");
    const handles = store.participants(room.id).map((p) => p.handle);
    const missing = participants.filter((handle) => !handles.includes(handle));
    if (missing.length > 0) throw new Error(`not in room: ${missing.map((h) => `@${h}`).join(", ")}`);
    const order = uniq(participants);
    if (order.length < 2) throw new Error("rounds need at least two participants");

    store.appendMessage(room.id, author, text, order);
    postSystem(room.id, `Rounds started: ${order.map((h) => `@${h}`).join(" -> ")} for up to ${total} round(s). A round settles early when every participant ends a reply with SETTLED.`);

    const state: RoundsState = {
      roomId: room.id,
      participants: order,
      total,
      round: 0,
      current: null,
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    rounds.set(room.id, state);
    void runRounds(state);
  }

  async function runRounds(state: RoundsState): Promise<void> {
    const { roomId, controller } = state;
    const signal = controller.signal;
    let outcome = `stopped after ${state.total} round(s) without a settled agreement.`;
    try {
      for (state.round = 1; state.round <= state.total; state.round++) {
        const settled: boolean[] = [];
        for (const handle of state.participants) {
          if (signal.aborted) throw new Error("cancelled");
          state.current = handle;
          publish(roomId);
          const others = state.participants.filter((h) => h !== handle).map((h) => `@${h}`).join(", ");
          const instruction = [
            `Round ${state.round} of ${state.total}. It is your turn, @${handle}.`,
            `Respond to the latest points from ${others}. Resolve disagreements with specifics.`,
            "If you fully agree with the others and have nothing to add, end your reply with a line containing only: SETTLED",
          ].join(" ");
          const reply = waitForReply(roomId, handle, signal);
          try {
            await deliver(roomId, handle, instruction);
          } catch (cause) {
            settlePending(roomId, handle, { error: new Error(errorMessage(cause)) });
            throw cause;
          }
          settled.push(isSettled(await reply));
        }
        if (settled.length > 0 && settled.every(Boolean)) {
          outcome = `settled after ${state.round} round(s).`;
          break;
        }
      }
    } catch (cause) {
      outcome = signal.aborted ? "cancelled by the user." : `stopped: ${errorMessage(cause)}`;
    } finally {
      rounds.delete(roomId);
      state.current = null;
      if (store.room(roomId) !== undefined) postSystem(roomId, `Rounds ${outcome}`);
    }
  }

  async function cancelRounds(roomId: string): Promise<void> {
    const state = rounds.get(roomId);
    if (state === undefined) return;
    const current = state.current;
    state.controller.abort();
    if (current !== null) {
      // Drop the pending wait first so the stop's idle transition is not
      // mistaken for a reply, then release the participant's runtime.
      settlePending(roomId, current, { error: new Error("cancelled") });
      const participant = store.participant(roomId, current);
      if (participant?.thread_id) {
        await bb.sdk.threads.stop({ threadId: participant.thread_id }).catch((cause: unknown) => {
          bb.log.warn(`stop @${current} failed: ${errorMessage(cause)}`);
        });
      }
    }
  }

  function roundsView(roomId: string): Rounds {
    const state = rounds.get(roomId);
    if (state === undefined) return null;
    return {
      total: state.total,
      round: state.round,
      participants: state.participants,
      current: state.current,
      startedAt: state.startedAt,
    };
  }

  // -- lifecycle events -----------------------------------------------------

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const participant = store.participantByThread(thread.id);
    if (participant === undefined) return;
    const key = pendingKey(participant.room_id, participant.handle);
    // Only turns the room asked for are posted back; a manual side conversation
    // in the participant's own thread stays there.
    if (!awaiting.has(key)) return;
    let text = lastAssistantText?.trim() ?? "";
    if (text === "") {
      try {
        text = (await bb.sdk.threads.output({ threadId: thread.id })).output?.trim() ?? "";
      } catch (cause) {
        bb.log.warn(`output for ${thread.id} failed: ${errorMessage(cause)}`);
      }
    }
    if (text === "") text = "(no reply text)";
    const handles = store.participants(participant.room_id).map((p) => p.handle);
    store.appendMessage(participant.room_id, participant.handle, text, mentionsIn(text, handles, participant.handle));
    publish(participant.room_id);
    settlePending(participant.room_id, participant.handle, { text });
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

  // -- read models ----------------------------------------------------------

  async function roomDetail(roomId: string): Promise<RoomDetail> {
    const room = store.room(roomId);
    if (room === undefined) throw new Error(`room ${roomId} not found`);
    const rows = store.participants(room.id);
    const participants = await Promise.all(
      rows.map(async (row): Promise<Participant> => {
        let status: string | null = null;
        if (row.thread_id !== null) {
          try {
            status = (await bb.sdk.threads.get({ threadId: row.thread_id })).status;
          } catch {
            status = null;
          }
        }
        return {
          handle: row.handle,
          providerId: row.provider_id,
          model: row.model,
          reasoningLevel: row.reasoning_level,
          threadId: row.thread_id,
          lastSeenSeq: row.last_seen_seq,
          status,
        };
      }),
    );
    let workspacePath: string | null = null;
    if (room.environment_id !== null) {
      try {
        workspacePath = (await bb.sdk.environments.get({ environmentId: room.environment_id })).path;
      } catch {
        workspacePath = null;
      }
    }
    return {
      room: toRoom(room),
      participants,
      messages: store.messages(room.id).map(toMessage),
      rounds: roundsView(room.id),
      workspacePath,
    };
  }

  function roomSummaries(): RoomSummary[] {
    return store.rooms().map((row) => ({
      ...toRoom(row),
      handles: store.participants(row.id).map((p) => p.handle),
      messageCount: store.q.messageCount.get(row.id)?.n ?? 0,
      lastAuthor: store.q.lastMessage.get(row.id)?.author ?? null,
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
    await cancelRounds(room.id);
    for (const participant of store.participants(room.id)) {
      settlePending(room.id, participant.handle, { error: new Error("room archived") });
      if (participant.thread_id === null) continue;
      try {
        await bb.sdk.threads.archive({ threadId: participant.thread_id });
        await bb.sdk.threads.stop({ threadId: participant.thread_id });
      } catch (cause) {
        bb.log.warn(`archive @${participant.handle} failed: ${errorMessage(cause)}`);
      }
    }
    store.q.archiveRoom.run(Date.now(), room.id);
    publish(room.id);
  }

  async function createRoom(title: string, projectId: string, participants: ParticipantInput[]): Promise<Room> {
    const handles = participants.map((p) => p.handle);
    if (uniq(handles).length !== handles.length) throw new Error("participant handles must be unique");
    if (handles.includes("user") || handles.includes("system")) throw new Error("\"user\" and \"system\" are reserved handles");
    const providers = await providerDirectory();
    for (const p of participants) {
      if (!providers.has(p.providerId)) throw new Error(`unknown provider ${p.providerId}`);
    }
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    if (!projects.some((project) => project.id === projectId)) throw new Error(`unknown project ${projectId}`);
    const row = store.createRoom(title, projectId, participants);
    publish(row.id);
    return toRoom(row);
  }

  const USER_TAG_INSTRUCTION = "You were tagged by the user. Reply to the room.";

  bb.rpc.register(rpcContract, {
    rooms_list: () => ({ rooms: roomSummaries() }),
    rooms_create: async ({ title, projectId, participants }) => ({
      room: await createRoom(title, projectId, participants),
    }),
    rooms_get: ({ roomId }) => roomDetail(roomId),
    rooms_post: async ({ roomId, text, tags }) => {
      const posted = postFrom(roomId, "user", text, tags);
      const dispatched = await dispatch(roomId, posted.tags, USER_TAG_INSTRUCTION);
      return { seq: posted.seq, dispatched };
    },
    rooms_start_rounds: ({ roomId, text, participants, rounds: total }) => {
      startRounds(roomId, text, participants, total, "user");
      return { ok: true as const };
    },
    rooms_cancel_rounds: async ({ roomId }) => {
      await cancelRounds(roomId);
      return { ok: true as const };
    },
    rooms_archive: async ({ roomId }) => {
      await archiveRoom(roomId);
      return { ok: true as const };
    },
    context_options: () => contextOptions(),
  });

  // -- CLI ------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb roundtable list [--json]",
    "  bb roundtable show <room> [--since <seq>] [--json]",
    "  bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code,codex=codex,devin=acp-devin] [--json]",
    "  bb roundtable say <room> [--to a,b] [--as <handle>] <message...>",
    "  bb roundtable rounds <room> --between a,b [--rounds N] <message...>",
    "  bb roundtable cancel <room>",
    "  bb roundtable archive <room>",
    "",
    "<room> is a room id or its exact title. Inside a participant thread, `say`",
    "posts as that participant automatically. @handle mentions in a message tag",
    "those participants even without --to.",
  ].join("\n");

  interface ParsedArgs {
    positional: string[];
    flags: Map<string, string | true>;
  }
  const VALUE_FLAGS = new Set(["to", "as", "since", "title", "project", "participants", "between", "rounds"]);
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
      if (eq !== -1) {
        flags.set(name, arg.slice(eq + 1));
      } else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) {
        flags.set(name, argv[++i]);
      } else {
        flags.set(name, true);
      }
    }
    return { positional, flags };
  }
  function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  }
  function splitList(value: string | undefined): string[] {
    return value === undefined ? [] : value.split(",").map((v) => v.trim()).filter((v) => v !== "");
  }

  function formatRoomLine(room: RoomSummary): string {
    return `${room.id}  ${room.title}  [${room.handles.map((h) => `@${h}`).join(" ")}]  ${room.messageCount} msg`;
  }

  bb.cli.register({
    name: "roundtable",
    summary: "Group chat rooms shared by several agents: read the room, post to it, tag participants, run rounds",
    commands: [
      { name: "list", summary: "List rooms", usage: "bb roundtable list [--json]" },
      { name: "show", summary: "Print a room transcript", usage: "bb roundtable show <room> [--since <seq>] [--json]" },
      { name: "create", summary: "Create a room", usage: "bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code,codex=codex,devin=acp-devin]" },
      { name: "say", summary: "Post to a room and optionally tag participants", usage: "bb roundtable say <room> [--to a,b] [--as <handle>] <message...>" },
      { name: "rounds", summary: "Run bounded back-and-forth rounds between participants", usage: "bb roundtable rounds <room> --between a,b [--rounds N] <message...>" },
      { name: "cancel", summary: "Cancel running rounds", usage: "bb roundtable cancel <room>" },
      { name: "archive", summary: "Archive a room and stop its participant threads", usage: "bb roundtable archive <room>" },
    ],
    async run(argv, ctx) {
      const { positional, flags } = parseArgs(argv);
      const json = flags.has("json");
      const [command, ...rest] = positional;
      const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const fail = (text: string) => ({ exitCode: 1, stderr: text });
      const resolveRoom = (ref: string | undefined): RoomRow | undefined =>
        ref === undefined ? undefined : store.room(ref);

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
            const header = `${room.title} (${room.id}) — ${detail.participants.map((p) => `@${p.handle}=${p.providerId}${p.status ? `:${p.status}` : ""}`).join(", ")}`;
            const body = messages.length === 0
              ? "(no messages)"
              : messages.map((m) => `### ${authorLabel(m.author)} (#${m.seq})\n${m.text}`).join("\n\n");
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
              const [handle, providerId, model] = entry.split("=");
              if (!handle || !providerId || !HANDLE_RE.test(handle)) return fail(`bad participant "${entry}"; use handle=provider[=model]`);
              participants.push({ handle, providerId, ...(model ? { model } : {}) });
            }
            const room = await createRoom(title, projectId, participants);
            return ok(room, `Created room ${room.id} "${room.title}" with ${participants.map((p) => `@${p.handle}`).join(", ")}`);
          }
          case "say": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            const text = rest.slice(1).join(" ").trim();
            if (text === "") return fail("say needs a message");
            const speaker = ctx.threadId === undefined ? undefined : store.participantByThread(ctx.threadId);
            const author = flagString(flags, "as") ?? (speaker !== undefined && speaker.room_id === room.id ? speaker.handle : "user");
            const posted = postFrom(room.id, author, text, splitList(flagString(flags, "to")));
            const instruction = author === "user"
              ? USER_TAG_INSTRUCTION
              : `You were tagged by @${author}. Reply to the room.`;
            const dispatched = await dispatch(room.id, posted.tags, instruction);
            return ok({ seq: posted.seq, author, dispatched }, `Posted #${posted.seq} as ${authorLabel(author)}${dispatched.length ? `; tagged ${dispatched.map((h) => `@${h}`).join(", ")}` : ""}`);
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
            const speaker = ctx.threadId === undefined ? undefined : store.participantByThread(ctx.threadId);
            const author = flagString(flags, "as") ?? (speaker !== undefined && speaker.room_id === room.id ? speaker.handle : "user");
            startRounds(room.id, text, between, total, author);
            return ok({ ok: true }, `Started ${total} round(s) between ${between.map((h) => `@${h}`).join(", ")}`);
          }
          case "cancel": {
            const room = resolveRoom(rest[0]);
            if (room === undefined) return fail(`Unknown room "${rest[0] ?? ""}".`);
            await cancelRounds(room.id);
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
    for (const state of rounds.values()) state.controller.abort();
    rounds.clear();
    for (const list of pending.values()) {
      for (const entry of list) entry.reject(new Error("plugin disposed"));
    }
    pending.clear();
    bb.log.info("disposed");
  });

  bb.log.info("loaded");
}
