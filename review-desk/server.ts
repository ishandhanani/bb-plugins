// bb-plugin-review-desk — server entry.
//
// Owns review records, GitHub caches, pending comments, chat seats and the
// codemap cache in the plugin's SQLite. Talks to the machine that holds the
// repository through the host entry (git, gh, tree-sitter). Chat with the PR
// runs on ordinary hidden bb threads (one per provider per review) spawned into
// the PR worktree; the UI renders them with bb's own ThreadChat.
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi, type PluginMentionItem, type PluginMentionSearchContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MENTION_PROVIDER_ID, decodeMentionRef, encodeMentionRef, mentionLabel, type MentionRef } from "./mention-ref";
import { computeSlop, type SlopReport } from "./slop";
import { BRIEF_FENCE, type Brief, type BriefEvidence } from "./brief-spec";
import {
  changedFileSchema,
  codemapSchema,
  ghIssueCommentSchema,
  ghReviewSchema,
  ghThreadSchema,
  hostContract,
  type ChangedFile,
  type Codemap,
  type GhPr,
  type GhThread,
} from "./host-contract";

// ---------------------------------------------------------------------------
// Wire schemas (shared with app.tsx through type-only imports)
// ---------------------------------------------------------------------------

const sideSchema = z.enum(["old", "new"]);
export type Side = z.infer<typeof sideSchema>;

const checkSchema = z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() });

const reviewSchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  author: z.string().nullable(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullable(),
  labels: z.array(z.string()),
  checks: z.array(checkSchema),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  commits: z.array(z.object({ sha: z.string(), title: z.string(), author: z.string(), date: z.string() })),
  createdAt: z.string(),
  worktree: z.string(),
  environmentId: z.string().nullable(),
  hostId: z.string(),
  syncedAt: z.number(),
  ghUpdatedAt: z.string(),
});
export type Review = z.infer<typeof reviewSchema>;

const reviewSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  headSha: z.string(),
  pendingCount: z.number(),
  updatedAt: z.number(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

const fileEntrySchema = changedFileSchema.extend({
  viewed: z.boolean(),
  threadCount: z.number(),
  unresolvedCount: z.number(),
  pendingCount: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

const pendingSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  line: z.number(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
  createdAt: z.number(),
});
export type PendingComment = z.infer<typeof pendingSchema>;

const seatSchema = z.object({
  providerId: z.string(),
  threadId: z.string(),
  environmentId: z.string().nullable(),
  createdAt: z.number(),
});
export type Seat = z.infer<typeof seatSchema>;

const selectionSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  side: sideSchema,
});
export type SelectionRef = z.infer<typeof selectionSchema>;

const codemapStateSchema = z.object({
  status: z.enum(["missing", "building", "ready", "failed"]),
  codemap: codemapSchema.nullable(),
  error: z.string().nullable(),
  updatedAt: z.number().nullable(),
});
export type CodemapState = z.infer<typeof codemapStateSchema>;

const providerOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  models: z.array(z.object({ model: z.string(), displayName: z.string(), isDefault: z.boolean() })),
});
export type ProviderOption = z.infer<typeof providerOptionSchema>;

/** The Brief tab's state: deterministic slop signals plus the helper-written brief. Payloads stay loose on the wire; app.tsx casts to the shared types. */
const briefStateSchema = z.object({
  headSha: z.string(),
  signalsStatus: z.enum(["missing", "computing", "ready", "failed"]),
  signals: z.record(z.string(), z.unknown()).nullable(),
  signalsError: z.string().nullable(),
  briefStatus: z.enum(["missing", "writing", "ready", "failed"]),
  brief: z.record(z.string(), z.unknown()).nullable(),
  briefError: z.string().nullable(),
  /** The stored brief was written for an older head. */
  stale: z.boolean(),
  updatedAt: z.number().nullable(),
});
export type BriefState = z.infer<typeof briefStateSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const reviewIdSchema = z.object({ reviewId: z.string() });

export const rpcContract = defineRpcContract({
  reviews_list: { input: z.null(), output: z.object({ reviews: z.array(reviewSummarySchema) }) },
  reviews_open: { input: z.object({ ref: z.string().trim().min(1) }), output: z.object({ review: reviewSchema }) },
  reviews_get: {
    input: reviewIdSchema,
    output: z.object({
      review: reviewSchema,
      files: z.array(fileEntrySchema),
      pending: z.array(pendingSchema),
      threads: z.array(ghThreadSchema),
      seats: z.array(seatSchema),
      /** Project the analyst threads are created in (the composer needs one). */
      chatProjectId: z.string(),
    }),
  },
  reviews_sync: { input: reviewIdSchema, output: z.object({ review: reviewSchema, headChanged: z.boolean() }) },
  reviews_remove: { input: reviewIdSchema, output: okSchema },
  review_patch: {
    input: z.object({ reviewId: z.string(), path: z.string() }),
    output: z.object({ patch: z.string(), file: changedFileSchema.nullable() }),
  },
  review_file: {
    input: z.object({ reviewId: z.string(), path: z.string(), side: sideSchema }),
    output: z.object({ content: z.string().nullable(), binary: z.boolean() }),
  },
  review_conversation: {
    input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }),
    output: z.object({ comments: z.array(ghIssueCommentSchema), reviews: z.array(ghReviewSchema), fetchedAt: z.number().nullable() }),
  },
  review_threads_refresh: { input: reviewIdSchema, output: z.object({ threads: z.array(ghThreadSchema) }) },
  viewed_set: { input: z.object({ reviewId: z.string(), path: z.string(), viewed: z.boolean() }), output: okSchema },
  pending_add: {
    input: z.object({
      reviewId: z.string(),
      path: z.string(),
      line: z.number().int().min(1),
      startLine: z.number().int().min(1).nullable().optional(),
      side: z.enum(["LEFT", "RIGHT"]),
      body: z.string().trim().min(1).max(20_000),
    }),
    output: z.object({ pending: pendingSchema }),
  },
  pending_update: { input: z.object({ id: z.string(), body: z.string().trim().min(1).max(20_000) }), output: z.object({ pending: pendingSchema }) },
  pending_delete: { input: z.object({ id: z.string() }), output: okSchema },
  review_submit: {
    input: z.object({ reviewId: z.string(), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string().max(20_000) }),
    output: z.object({ url: z.string().nullable(), posted: z.number() }),
  },
  thread_reply: { input: z.object({ reviewId: z.string(), commentId: z.number(), body: z.string().trim().min(1).max(20_000) }), output: okSchema },
  thread_resolve: { input: z.object({ reviewId: z.string(), threadId: z.string(), resolve: z.boolean() }), output: okSchema },
  /** Send a chat message to the analyst for a provider, spawning it on first use. */
  chat_send: {
    input: z.object({
      reviewId: z.string(),
      providerId: z.string().min(1),
      model: z.string().nullable().optional(),
      text: z.string().trim().min(1).max(20_000),
      selection: selectionSchema.nullable().optional(),
    }),
    output: z.object({ seat: seatSchema }),
  },
  /**
   * Start or continue a chat from bb's own new-thread composer: the input is
   * the composer's prompt blocks (text, @-mention pills, attachments) and the
   * execution choices the user made on screen. Spawns the seat on first use
   * with the analyst intro as agent-only context ahead of the message.
   */
  chat_start: {
    input: z.object({
      reviewId: z.string(),
      providerId: z.string().min(1),
      model: z.string().min(1).optional(),
      reasoningLevel: z.string().optional(),
      permissionMode: z.string().optional(),
      serviceTier: z.string().optional(),
      executionInputSources: z.record(z.string(), z.enum(["client-preference", "explicit"])).optional(),
      input: z.array(z.record(z.string(), z.unknown())).min(1),
    }),
    output: z.object({ seat: seatSchema }),
  },
  /** Which review a thread belongs to, if it is one of our analyst seats. */
  seat_lookup: { input: z.object({ threadId: z.string() }), output: z.object({ seat: z.object({ reviewId: z.string(), providerId: z.string() }).nullable() }) },
  chat_reset: { input: z.object({ reviewId: z.string(), providerId: z.string() }), output: okSchema },
  codemap_get: { input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }), output: codemapStateSchema },
  rooms_list: { input: z.null(), output: z.object({ rooms: z.array(z.object({ id: z.string(), title: z.string(), handles: z.array(z.string()) })), available: z.boolean() }) },
  send_to_room: {
    input: z.object({ roomId: z.string(), text: z.string().trim().min(1).max(20_000), tags: z.array(z.string()).max(8), turns: z.number().int().min(0).max(40).optional() }),
    output: okSchema,
  },
  context_providers: { input: z.null(), output: z.object({ providers: z.array(providerOptionSchema), defaultProvider: z.string() }) },
  /** Signals compute on first call for a head; the brief is written on first call too when autoBrief is on. */
  brief_get: { input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }), output: briefStateSchema },
  /** (Re)write the plain-English brief at the current head. */
  brief_write: { input: reviewIdSchema, output: briefStateSchema },
});

export const REVIEW_CHANGED = "review-changed";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS reviews (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL,
     is_draft INTEGER NOT NULL DEFAULT 0,
     url TEXT NOT NULL,
     author TEXT,
     base_ref TEXT NOT NULL,
     head_ref TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     additions INTEGER NOT NULL DEFAULT 0,
     deletions INTEGER NOT NULL DEFAULT 0,
     changed_files INTEGER NOT NULL DEFAULT 0,
     review_decision TEXT,
     mergeable TEXT,
     labels_json TEXT NOT NULL DEFAULT '[]',
     checks_json TEXT NOT NULL DEFAULT '[]',
     reviewers_json TEXT NOT NULL DEFAULT '[]',
     assignees_json TEXT NOT NULL DEFAULT '[]',
     commits_json TEXT NOT NULL DEFAULT '[]',
     gh_created_at TEXT NOT NULL DEFAULT '',
     worktree TEXT NOT NULL,
     environment_id TEXT,
     host_id TEXT NOT NULL,
     repo_path TEXT NOT NULL,
     project_id TEXT,
     gh_updated_at TEXT NOT NULL DEFAULT '',
     synced_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(owner, repo, number)
   )`,
  `CREATE TABLE IF NOT EXISTS files_cache (review_id TEXT PRIMARY KEY, head_sha TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS viewed (review_id TEXT NOT NULL, path TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY (review_id, path))`,
  `CREATE TABLE IF NOT EXISTS threads_cache (review_id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS conversation_cache (review_id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     path TEXT NOT NULL,
     line INTEGER NOT NULL,
     start_line INTEGER,
     side TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seats (review_id TEXT NOT NULL, provider_id TEXT NOT NULL, thread_id TEXT NOT NULL, environment_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (review_id, provider_id))`,
  `CREATE TABLE IF NOT EXISTS codemaps (review_id TEXT PRIMARY KEY, head_sha TEXT NOT NULL, status TEXT NOT NULL, json TEXT, error TEXT, updated_at INTEGER NOT NULL)`,
  // Migrations are append-only and hash-checked; these two tables belonged to a
  // removed diagrams feature and stay declared so existing databases still match.
  `CREATE TABLE IF NOT EXISTS illustrators (review_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_id TEXT NOT NULL, environment_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS diagrams (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     preset TEXT NOT NULL,
     target_json TEXT,
     prompt TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     spec_json TEXT,
     raw TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // One hidden helper thread per review runs one-shot jobs (the brief, later notes).
  `CREATE TABLE IF NOT EXISTS helpers (review_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_id TEXT NOT NULL, environment_id TEXT, job TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS briefs (
     review_id TEXT PRIMARY KEY,
     head_sha TEXT NOT NULL,
     signals_status TEXT NOT NULL DEFAULT 'missing',
     signals_json TEXT,
     signals_error TEXT,
     brief_status TEXT NOT NULL DEFAULT 'missing',
     brief_head_sha TEXT,
     brief_json TEXT,
     brief_raw TEXT,
     brief_error TEXT,
     updated_at INTEGER NOT NULL
   )`,
];

interface ReviewRow {
  id: string; owner: string; repo: string; number: number; title: string; body: string; state: string; is_draft: number; url: string; author: string | null;
  base_ref: string; head_ref: string; head_sha: string; base_sha: string; additions: number; deletions: number; changed_files: number;
  review_decision: string | null; mergeable: string | null; labels_json: string; checks_json: string; reviewers_json: string; assignees_json: string; commits_json: string; gh_created_at: string;
  worktree: string; environment_id: string | null; host_id: string; repo_path: string; project_id: string | null; gh_updated_at: string; synced_at: number; created_at: number; updated_at: number;
}
interface PendingRow { id: string; review_id: string; path: string; line: number; start_line: number | null; side: string; body: string; created_at: number }
interface SeatRow { review_id: string; provider_id: string; thread_id: string; environment_id: string | null; created_at: number }
interface CodemapRow { review_id: string; head_sha: string; status: string; json: string | null; error: string | null; updated_at: number }
interface CacheRow { review_id: string; json: string; fetched_at: number }
interface HelperRow { review_id: string; thread_id: string; provider_id: string; environment_id: string | null; job: string | null; created_at: number }
interface BriefRow {
  review_id: string; head_sha: string; signals_status: string; signals_json: string | null; signals_error: string | null;
  brief_status: string; brief_head_sha: string | null; brief_json: string | null; brief_raw: string | null; brief_error: string | null; updated_at: number;
}

function newId(): string {
  return randomBytes(6).toString("hex");
}

function createStore(db: Database.Database) {
  const q = {
    reviews: db.prepare<[], ReviewRow>(`SELECT * FROM reviews ORDER BY updated_at DESC`),
    review: db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE id = ?`),
    reviewByKey: db.prepare<[string, string, number], ReviewRow>(`SELECT * FROM reviews WHERE owner = ? AND repo = ? AND number = ?`),
    insertReview: db.prepare<[string, string, string, number, string, string, string, string, string, string | null, number, number, number]>(
      `INSERT INTO reviews (id, owner, repo, number, title, state, url, base_ref, head_ref, head_sha, base_sha, worktree, host_id, repo_path, project_id, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, '', '', '', '', ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateReviewMeta: db.prepare<[string, string, string, number, string | null, string, string, string, string, number, number, number, string | null, string | null, string, string, string, string, string, string, string, string, number, number, string]>(
      `UPDATE reviews SET title = ?, body = ?, state = ?, is_draft = ?, author = ?, base_ref = ?, head_ref = ?, head_sha = ?, base_sha = ?, additions = ?, deletions = ?, changed_files = ?, review_decision = ?, mergeable = ?, labels_json = ?, checks_json = ?, reviewers_json = ?, assignees_json = ?, commits_json = ?, gh_created_at = ?, worktree = ?, gh_updated_at = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
    ),
    setEnvironment: db.prepare<[string, string]>(`UPDATE reviews SET environment_id = ? WHERE id = ?`),
    touch: db.prepare<[number, string]>(`UPDATE reviews SET updated_at = ? WHERE id = ?`),
    deleteReview: db.prepare<[string]>(`DELETE FROM reviews WHERE id = ?`),
    filesCache: db.prepare<[string], { head_sha: string; json: string }>(`SELECT head_sha, json FROM files_cache WHERE review_id = ?`),
    setFilesCache: db.prepare<[string, string, string]>(`INSERT INTO files_cache (review_id, head_sha, json) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET head_sha = excluded.head_sha, json = excluded.json`),
    viewed: db.prepare<[string], { path: string }>(`SELECT path FROM viewed WHERE review_id = ?`),
    setViewed: db.prepare<[string, string, number]>(`INSERT OR REPLACE INTO viewed (review_id, path, viewed_at) VALUES (?, ?, ?)`),
    unsetViewed: db.prepare<[string, string]>(`DELETE FROM viewed WHERE review_id = ? AND path = ?`),
    threadsCache: db.prepare<[string], CacheRow>(`SELECT * FROM threads_cache WHERE review_id = ?`),
    setThreadsCache: db.prepare<[string, string, number]>(`INSERT INTO threads_cache (review_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`),
    conversationCache: db.prepare<[string], CacheRow>(`SELECT * FROM conversation_cache WHERE review_id = ?`),
    setConversationCache: db.prepare<[string, string, number]>(`INSERT INTO conversation_cache (review_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`),
    pending: db.prepare<[string], PendingRow>(`SELECT * FROM pending WHERE review_id = ? ORDER BY created_at ASC`),
    pendingById: db.prepare<[string], PendingRow>(`SELECT * FROM pending WHERE id = ?`),
    insertPending: db.prepare<[string, string, string, number, number | null, string, string, number]>(
      `INSERT INTO pending (id, review_id, path, line, start_line, side, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updatePending: db.prepare<[string, string]>(`UPDATE pending SET body = ? WHERE id = ?`),
    deletePending: db.prepare<[string]>(`DELETE FROM pending WHERE id = ?`),
    clearPending: db.prepare<[string]>(`DELETE FROM pending WHERE review_id = ?`),
    seat: db.prepare<[string, string], SeatRow>(`SELECT * FROM seats WHERE review_id = ? AND provider_id = ?`),
    seats: db.prepare<[string], SeatRow>(`SELECT * FROM seats WHERE review_id = ? ORDER BY created_at ASC`),
    seatByThread: db.prepare<[string], SeatRow>(`SELECT * FROM seats WHERE thread_id = ?`),
    reviewsByProject: db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE project_id = ? ORDER BY updated_at DESC`),
    upsertSeat: db.prepare<[string, string, string, string | null, number]>(
      `INSERT INTO seats (review_id, provider_id, thread_id, environment_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(review_id, provider_id) DO UPDATE SET thread_id = excluded.thread_id, environment_id = excluded.environment_id`,
    ),
    deleteSeat: db.prepare<[string, string]>(`DELETE FROM seats WHERE review_id = ? AND provider_id = ?`),
    helper: db.prepare<[string], HelperRow>(`SELECT * FROM helpers WHERE review_id = ?`),
    helperByThread: db.prepare<[string], HelperRow>(`SELECT * FROM helpers WHERE thread_id = ?`),
    upsertHelper: db.prepare<[string, string, string, string | null, number]>(
      `INSERT INTO helpers (review_id, thread_id, provider_id, environment_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET thread_id = excluded.thread_id, provider_id = excluded.provider_id, environment_id = excluded.environment_id`,
    ),
    setHelperJob: db.prepare<[string | null, string]>(`UPDATE helpers SET job = ? WHERE review_id = ?`),
    deleteHelper: db.prepare<[string]>(`DELETE FROM helpers WHERE review_id = ?`),
    brief: db.prepare<[string], BriefRow>(`SELECT * FROM briefs WHERE review_id = ?`),
    ensureBrief: db.prepare<[string, string, number]>(`INSERT INTO briefs (review_id, head_sha, updated_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO NOTHING`),
    setSignals: db.prepare<[string, string, string | null, string | null, number, string]>(
      `UPDATE briefs SET head_sha = ?, signals_status = ?, signals_json = ?, signals_error = ?, updated_at = ? WHERE review_id = ?`,
    ),
    setBrief: db.prepare<[string, string | null, string | null, string | null, string | null, number, string]>(
      `UPDATE briefs SET brief_status = ?, brief_head_sha = ?, brief_json = ?, brief_raw = ?, brief_error = ?, updated_at = ? WHERE review_id = ?`,
    ),
    codemap: db.prepare<[string], CodemapRow>(`SELECT * FROM codemaps WHERE review_id = ?`),
    setCodemap: db.prepare<[string, string, string, string | null, string | null, number]>(
      `INSERT INTO codemaps (review_id, head_sha, status, json, error, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET head_sha = excluded.head_sha, status = excluded.status, json = excluded.json, error = excluded.error, updated_at = excluded.updated_at`,
    ),
  };
  return { q };
}
type Store = ReturnType<typeof createStore>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    isDraft: row.is_draft === 1,
    url: row.url,
    author: row.author,
    baseRefName: row.base_ref,
    headRefName: row.head_ref,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changed_files,
    reviewDecision: row.review_decision,
    mergeable: row.mergeable,
    labels: parseJson<string[]>(row.labels_json, []),
    checks: parseJson<Review["checks"]>(row.checks_json, []),
    reviewers: parseJson<Review["reviewers"]>(row.reviewers_json, []),
    assignees: parseJson<string[]>(row.assignees_json, []),
    commits: parseJson<Review["commits"]>(row.commits_json, []),
    createdAt: row.gh_created_at,
    worktree: row.worktree,
    environmentId: row.environment_id,
    hostId: row.host_id,
    syncedAt: row.synced_at,
    ghUpdatedAt: row.gh_updated_at,
  };
}

function toPending(row: PendingRow): PendingComment {
  return {
    id: row.id,
    reviewId: row.review_id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    body: row.body,
    createdAt: row.created_at,
  };
}

function toSeat(row: SeatRow): Seat {
  return { providerId: row.provider_id, threadId: row.thread_id, environmentId: row.environment_id, createdAt: row.created_at };
}

/** owner/repo#N, owner/repo/pull/N, or a full GitHub URL. */
function parsePrRef(ref: string): { owner: string; repo: string; number: number } | null {
  const url = ref.match(/github\.com\/([^/\s]+)\/([^/\s#]+)\/pull\/(\d+)/i);
  if (url) return { owner: url[1], repo: url[2].replace(/\.git$/, ""), number: Number(url[3]) };
  const short = ref.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#|\/pull\/|\s+)(\d+)$/);
  if (short) return { owner: short[1], repo: short[2].replace(/\.git$/, ""), number: Number(short[3]) };
  return null;
}

function remoteMatches(remote: string | null, owner: string, repo: string): boolean {
  if (remote === null) return false;
  const normalized = remote.replace(/\.git$/, "").toLowerCase();
  return normalized.endsWith(`${owner}/${repo}`.toLowerCase());
}

function wasmDirCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [`${here}node_modules/@vscode/tree-sitter-wasm/wasm`, `${here}../node_modules/@vscode/tree-sitter-wasm/wasm`];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultProvider: { type: "string", label: "Default AI provider id for the PR chat", default: "claude-code" },
    hideSeatThreads: { type: "boolean", label: "Hide analyst threads from the sidebar", default: true },
    autoBrief: { type: "boolean", label: "Write the plain-English brief when a review is first opened at a new head", default: true },
  });
  const { defaultProvider, hideSeatThreads, autoBrief } = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const { q }: Store = createStore(db);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const codemapBuilds = new Set<string>();

  const publish = (reviewId: string, what: string) => bb.realtime.publish(REVIEW_CHANGED, { reviewId, what });

  function requireReview(reviewId: string): ReviewRow {
    const row = q.review.get(reviewId);
    if (row === undefined) throw new Error(`review ${reviewId} not found`);
    return row;
  }

  const hostOptions = (row: ReviewRow) => ({ hostId: row.host_id });

  async function primaryHostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((h) => h.status === "connected") ?? hosts[0];
    if (connected === undefined) throw new Error("no bb machine is connected");
    return connected.id;
  }

  // -- repository resolution -------------------------------------------------

  async function locateRepo(owner: string, repo: string): Promise<{ repoPath: string; hostId: string; projectId: string | null }> {
    const projects = await bb.sdk.projects.list();
    for (const project of projects) {
      if (!remoteMatches(project.gitRemoteUrl, owner, repo)) continue;
      const detail = await bb.sdk.projects.get({ projectId: project.id });
      const sources = (detail as { sources?: { type: string; path: string; hostId: string; isDefault: boolean }[] }).sources ?? [];
      const source = sources.find((s) => s.type === "local_path" && s.isDefault) ?? sources.find((s) => s.type === "local_path");
      if (source) return { repoPath: source.path, hostId: source.hostId, projectId: project.id };
    }
    const hostId = await primaryHostId();
    const cloned = await host.call("repo_clone", { owner, repo, dest: "" }, { hostId });
    return { repoPath: cloned.repoPath, hostId, projectId: null };
  }

  // -- open and sync ---------------------------------------------------------

  async function refreshFiles(row: ReviewRow): Promise<ChangedFile[]> {
    const result = await host.call("git_files", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha }, hostOptions(row));
    q.setFilesCache.run(row.id, row.head_sha, JSON.stringify(result.files));
    return result.files;
  }

  function cachedFiles(row: ReviewRow): ChangedFile[] | null {
    const cache = q.filesCache.get(row.id);
    if (cache === undefined || cache.head_sha !== row.head_sha) return null;
    return parseJson<ChangedFile[]>(cache.json, []);
  }

  async function filesFor(row: ReviewRow): Promise<ChangedFile[]> {
    return cachedFiles(row) ?? refreshFiles(row);
  }

  function applyPr(row: ReviewRow, pr: GhPr, prepared: { worktree: string; headSha: string; baseSha: string }): void {
    const now = Date.now();
    q.updateReviewMeta.run(
      pr.title, pr.body, pr.state, pr.isDraft ? 1 : 0, pr.author?.login ?? null, pr.baseRefName, pr.headRefName, prepared.headSha, prepared.baseSha,
      pr.additions, pr.deletions, pr.changedFiles, pr.reviewDecision, pr.mergeable, JSON.stringify(pr.labels), JSON.stringify(pr.checks),
      JSON.stringify(pr.reviewers), JSON.stringify(pr.assignees), JSON.stringify(pr.commits), pr.createdAt,
      prepared.worktree, pr.updatedAt, now, now, row.id,
    );
  }

  async function openReview(ref: string): Promise<Review> {
    const parsed = parsePrRef(ref);
    if (parsed === null) throw new Error("Give a PR URL, owner/repo#123, or owner/repo/pull/123");
    const existing = q.reviewByKey.get(parsed.owner, parsed.repo, parsed.number);
    if (existing !== undefined) {
      await syncReview(existing.id);
      return toReview(requireReview(existing.id));
    }
    const located = await locateRepo(parsed.owner, parsed.repo);
    const pr = await host.call("gh_pr", parsed, { hostId: located.hostId });
    const key = `${parsed.owner}__${parsed.repo}__${parsed.number}`;
    const prepared = await host.call(
      "repo_prepare",
      { repoPath: located.repoPath, number: parsed.number, headSha: pr.headRefOid, baseRefName: pr.baseRefName, worktreesDir: "", key },
      { hostId: located.hostId },
    );
    const id = newId();
    const now = Date.now();
    q.insertReview.run(id, parsed.owner, parsed.repo, parsed.number, pr.title, pr.url, prepared.worktree, located.hostId, located.repoPath, located.projectId, now, now, now);
    applyPr(requireReview(id), pr, prepared);
    const row = requireReview(id);
    await refreshFiles(row);
    void refreshThreads(row).catch((cause: unknown) => bb.log.warn(`threads for ${id}: ${errorMessage(cause)}`));
    publish(id, "opened");
    return toReview(row);
  }

  async function syncReview(reviewId: string): Promise<{ review: Review; headChanged: boolean }> {
    const row = requireReview(reviewId);
    const pr = await host.call("gh_pr", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    const headChanged = pr.headRefOid !== row.head_sha;
    const key = `${row.owner}__${row.repo}__${row.number}`;
    const prepared = await host.call(
      "repo_prepare",
      { repoPath: row.repo_path, number: row.number, headSha: pr.headRefOid, baseRefName: pr.baseRefName, worktreesDir: "", key },
      hostOptions(row),
    );
    applyPr(row, pr, prepared);
    const fresh = requireReview(reviewId);
    if (headChanged || cachedFiles(fresh) === null) await refreshFiles(fresh);
    await refreshThreads(fresh).catch((cause: unknown) => bb.log.warn(`threads for ${reviewId}: ${errorMessage(cause)}`));
    publish(reviewId, "synced");
    return { review: toReview(fresh), headChanged };
  }

  async function refreshThreads(row: ReviewRow): Promise<GhThread[]> {
    const result = await host.call("gh_threads", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    q.setThreadsCache.run(row.id, JSON.stringify(result.threads), Date.now());
    publish(row.id, "threads");
    return result.threads;
  }

  function cachedThreads(row: ReviewRow): GhThread[] {
    const cache = q.threadsCache.get(row.id);
    return cache === undefined ? [] : parseJson<GhThread[]>(cache.json, []);
  }

  // -- read model ------------------------------------------------------------

  async function reviewDetail(reviewId: string) {
    const row = requireReview(reviewId);
    const files = await filesFor(row);
    const viewed = new Set(q.viewed.all(row.id).map((v) => v.path));
    const threads = cachedThreads(row);
    const pending = q.pending.all(row.id).map(toPending);
    const perPath = new Map<string, { threads: number; unresolved: number; pending: number }>();
    const bump = (p: string, field: "threads" | "unresolved" | "pending") => {
      const entry = perPath.get(p) ?? { threads: 0, unresolved: 0, pending: 0 };
      entry[field]++;
      perPath.set(p, entry);
    };
    for (const t of threads) {
      bump(t.path, "threads");
      if (!t.isResolved) bump(t.path, "unresolved");
    }
    for (const p of pending) bump(p.path, "pending");
    return {
      review: toReview(row),
      files: files.map((f) => {
        const counts = perPath.get(f.path) ?? { threads: 0, unresolved: 0, pending: 0 };
        return { ...f, viewed: viewed.has(f.path), threadCount: counts.threads, unresolvedCount: counts.unresolved, pendingCount: counts.pending };
      }),
      pending,
      threads,
      seats: q.seats.all(row.id).map(toSeat),
      chatProjectId: await chatProjectId(row),
    };
  }

  // -- chat seats ------------------------------------------------------------

  async function waitForEnvironment(threadId: string, timeoutMs = 90_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) return thread.environmentId;
      } catch (cause) {
        bb.log.warn(`environment of ${threadId}: ${errorMessage(cause)}`);
      }
    }
    return null;
  }

  function seatIntro(row: ReviewRow): string {
    return [
      `You are the analyst for pull request #${row.number} of ${row.owner}/${row.repo}: "${row.title}". The reviewer will chat with you about the PR here.`,
      `Your working directory is a detached worktree at the PR head ${row.head_sha}. The merge base with ${row.base_ref} is ${row.base_sha}.`,
      `The full diff is: git diff ${row.base_sha} ${row.head_sha}. One file: git diff ${row.base_sha} ${row.head_sha} -- <path>. Base version of a file: git show ${row.base_sha}:<path>.`,
      "You are read-only: never modify files, never commit, never push. Read files and run read-only commands to verify claims before making them.",
      "The reviewer attaches code as pills: @-mentions of a line range, a changed file, a changed symbol, a GitHub review thread, or the PR description. Each pill's content arrives with the message as a context block titled \"Context for @<pill>\"; in range excerpts, > marks the selected lines. Treat those blocks as the code the reviewer is pointing at.",
      "Answer for the reviewer: specific, concise, citing paths and line numbers. When asked to draft a GitHub comment, write ready-to-post Markdown with no preamble.",
      "",
      "PR description:",
      row.body.trim() === "" ? "(none)" : row.body.trim().slice(0, 6000),
    ].join("\n");
  }

  async function excerpt(row: ReviewRow, selection: SelectionRef): Promise<string> {
    const sha = selection.side === "old" ? row.base_sha : row.head_sha;
    const result = await host.call("git_show", { worktree: row.worktree, sha, path: selection.path }, hostOptions(row));
    if (result.content === null) return "(file content unavailable)";
    const lines = result.content.split("\n");
    const start = Math.min(selection.startLine, selection.endLine);
    const end = Math.max(selection.startLine, selection.endLine);
    const from = Math.max(1, start - 6);
    const to = Math.min(lines.length, end + 6);
    const width = String(to).length;
    return lines
      .slice(from - 1, to)
      .map((line, i) => {
        const n = from + i;
        return `${n >= start && n <= end ? ">" : " "}${String(n).padStart(width)}| ${line}`;
      })
      .join("\n");
  }

  async function chatMessage(row: ReviewRow, text: string, selection: SelectionRef | null): Promise<string> {
    if (selection === null) return text;
    const start = Math.min(selection.startLine, selection.endLine);
    const end = Math.max(selection.startLine, selection.endLine);
    return [
      `Selected ${selection.path} lines ${start}-${end} (${selection.side === "old" ? "base" : "head"} side):`,
      "```",
      await excerpt(row, selection),
      "```",
      text,
    ].join("\n");
  }

  type SpawnArgs = Parameters<typeof bb.sdk.threads.spawn>[0];
  type PromptBlocks = Extract<SpawnArgs, { input: unknown }>["input"];
  type SpawnExecution = Pick<SpawnArgs, "model" | "reasoningLevel" | "permissionMode" | "serviceTier" | "executionInputSources">;

  async function chatProjectId(row: ReviewRow): Promise<string> {
    if (row.project_id !== null) return row.project_id;
    const projectId = (await bb.sdk.projects.list({ includePersonal: true })).find((p) => p.kind !== "standard")?.id;
    if (projectId === undefined) throw new Error("no project to spawn the analyst in");
    return projectId;
  }

  async function chatSend(reviewId: string, providerId: string, model: string | null, text: string, selection: SelectionRef | null): Promise<Seat> {
    const row = requireReview(reviewId);
    const message = await chatMessage(row, text, selection);
    return deliver(row, providerId, model === null ? {} : { model }, [{ type: "text", text: message, mentions: [] }]);
  }

  /**
   * Send prompt blocks to the provider's seat, spawning it on first use. The
   * blocks may carry @-mention pills; bb resolves those through our mention
   * provider when it accepts the message.
   */
  async function deliver(row: ReviewRow, providerId: string, execution: SpawnExecution, blocks: PromptBlocks): Promise<Seat> {
    const existing = q.seat.get(row.id, providerId);
    if (existing !== undefined) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: existing.thread_id });
        if (thread.archivedAt === null && thread.deletedAt === null) {
          await bb.sdk.threads.send({ threadId: existing.thread_id, mode: "auto", input: blocks });
          q.touch.run(Date.now(), row.id);
          return toSeat(existing);
        }
      } catch {
        // stale seat; respawn below
      }
      q.deleteSeat.run(row.id, providerId);
    }
    const providers = await bb.sdk.providers.list();
    const provider = providers.find((p) => p.id === providerId);
    if (provider === undefined) throw new Error(`unknown provider ${providerId}`);
    const modes = provider.capabilities.permissionModes;
    const permissionMode = execution.permissionMode ?? (modes.includes("auto") ? "auto" : modes.includes("accept-edits") ? "accept-edits" : undefined);
    const knownEnvironment = row.environment_id ?? q.seats.all(row.id).find((s) => s.environment_id !== null)?.environment_id ?? null;
    const projectId = await chatProjectId(row);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: knownEnvironment !== null
        ? { type: "reuse", environmentId: knownEnvironment }
        : { type: "host", hostId: row.host_id, workspace: { type: "unmanaged", path: row.worktree } },
      providerId,
      ...execution,
      ...(permissionMode ? { permissionMode } : {}),
      title: `Review Desk ${row.owner}/${row.repo}#${row.number}: ${provider.displayName}`,
      visibility: hideSeatThreads ? "hidden" : "visible",
      // The intro is agent-only context so the chat transcript starts with the
      // reviewer's own question.
      input: [{ type: "text", text: seatIntro(row), mentions: [], visibility: "agent-only" }, ...blocks],
    });
    const now = Date.now();
    q.upsertSeat.run(row.id, providerId, thread.id, knownEnvironment, now);
    publish(row.id, "seats");
    if (knownEnvironment === null) {
      void (async () => {
        const environmentId = thread.environmentId ?? (await waitForEnvironment(thread.id));
        if (environmentId !== null) {
          q.upsertSeat.run(row.id, providerId, thread.id, environmentId, now);
          q.setEnvironment.run(environmentId, row.id);
          publish(row.id, "seats");
        }
      })();
    }
    const seat = q.seat.get(row.id, providerId);
    if (seat === undefined) throw new Error("seat vanished");
    return toSeat(seat);
  }

  async function chatReset(reviewId: string, providerId: string): Promise<void> {
    const seat = q.seat.get(reviewId, providerId);
    if (seat === undefined) return;
    try {
      await bb.sdk.threads.archive({ threadId: seat.thread_id });
      await bb.sdk.threads.stop({ threadId: seat.thread_id });
    } catch (cause) {
      bb.log.warn(`reset seat ${providerId}: ${errorMessage(cause)}`);
    }
    q.deleteSeat.run(reviewId, providerId);
    publish(reviewId, "seats");
  }

  // -- codemap ---------------------------------------------------------------

  function codemapState(row: ReviewRow): CodemapState {
    const cached = q.codemap.get(row.id);
    if (cached === undefined || cached.head_sha !== row.head_sha) {
      return codemapBuilds.has(row.id) ? { status: "building", codemap: null, error: null, updatedAt: null } : { status: "missing", codemap: null, error: null, updatedAt: null };
    }
    if (cached.status === "ready") return { status: "ready", codemap: parseJson<Codemap | null>(cached.json, null), error: null, updatedAt: cached.updated_at };
    if (cached.status === "building") return { status: "building", codemap: null, error: null, updatedAt: cached.updated_at };
    return { status: "failed", codemap: null, error: cached.error, updatedAt: cached.updated_at };
  }

  function startCodemap(row: ReviewRow): void {
    if (codemapBuilds.has(row.id)) return;
    codemapBuilds.add(row.id);
    q.setCodemap.run(row.id, row.head_sha, "building", null, null, Date.now());
    publish(row.id, "codemap");
    void (async () => {
      try {
        const files = await filesFor(row);
        const wasmDir = wasmDirCandidates().find((dir) => existsSync(`${dir}/tree-sitter.wasm`)) ?? null;
        const codemap = await host.call("codemap", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, files, wasmDir }, hostOptions(row));
        q.setCodemap.run(row.id, row.head_sha, "ready", JSON.stringify(codemap), null, Date.now());
      } catch (cause) {
        q.setCodemap.run(row.id, row.head_sha, "failed", null, errorMessage(cause), Date.now());
      } finally {
        codemapBuilds.delete(row.id);
        publish(row.id, "codemap");
      }
    })();
  }

  // -- code pills (mention provider) -----------------------------------------
  //
  // `@` in a seat's composer searches this PR: changed files, changed symbols
  // from the codemap, GitHub review threads, the description, and explicit
  // `path:10-20` ranges. The picked item becomes a pill in the draft; bb calls
  // `resolve` when the message is sent and attaches the text as agent-only
  // context, so the transcript shows the pill and the analyst sees the code.

  interface ChangedSymbol { path: string; qualified: string; kind: string; status: string; start: number; end: number; oldStart: number | null; oldEnd: number | null; changedLines: number; fanIn: number }
  const symbolCache = new Map<string, { headSha: string; symbols: ChangedSymbol[] }>();

  function changedSymbols(row: ReviewRow): ChangedSymbol[] {
    const cached = symbolCache.get(row.id);
    if (cached !== undefined && cached.headSha === row.head_sha) return cached.symbols;
    const state = codemapState(row);
    if (state.status !== "ready" || state.codemap === null) return [];
    const symbols = state.codemap.files.flatMap((f) =>
      f.symbols
        .filter((s) => s.status !== "unchanged")
        .map((s) => ({ path: f.path, qualified: s.qualified.replace(/\s+/g, " "), kind: s.kind, status: s.status, start: s.start, end: s.end, oldStart: s.oldStart, oldEnd: s.oldEnd, changedLines: s.changedLines, fanIn: s.fanIn })),
    );
    symbolCache.set(row.id, { headSha: row.head_sha, symbols });
    return symbols;
  }

  /** The review a composer talks about: the seat's review for a thread composer, else the project's latest review. */
  function reviewForComposer(ctx: PluginMentionSearchContext): ReviewRow | null {
    if (ctx.threadId !== null) {
      const seat = q.seatByThread.get(ctx.threadId);
      return seat === undefined ? null : q.review.get(seat.review_id) ?? null;
    }
    if (ctx.projectId !== null) return q.reviewsByProject.all(ctx.projectId)[0] ?? null;
    return null;
  }

  const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  function matchScore(haystack: string, query: string, weight: number, fuzzy = false): number {
    if (query === "") return weight * 0.5;
    const h = haystack.toLowerCase();
    if (h === query) return weight * 3;
    if (h.startsWith(query)) return weight * 2;
    if (h.includes(query)) return weight;
    if (!fuzzy || query.length < 3) return 0;
    // Subsequence match for paths: "kvr/sel" finds kv-router/src/services/selection.
    let i = 0;
    for (const ch of h) {
      if (ch === query[i]) i++;
      if (i === query.length) return weight * 0.4;
    }
    return 0;
  }

  type ScoredItem = PluginMentionItem & { score: number };
  const scored = (ref: MentionRef, title: string, subtitle: string, icon: string, score: number): ScoredItem => ({ id: encodeMentionRef(ref), title, subtitle, icon, score });

  function mentionSearch(ctx: PluginMentionSearchContext): PluginMentionItem[] {
    const row = reviewForComposer(ctx);
    if (row === null) return [];
    const raw = ctx.query.trim();
    const query = raw.toLowerCase();
    const browsing = query === "";
    const files = cachedFiles(row) ?? [];
    const groups: ScoredItem[][] = [];

    // Explicit ranges: path:10-20, path:10, path#L10-L20.
    const range = /^(.*?)[:#]L?(\d+)(?:-L?(\d+))?$/.exec(raw);
    if (range !== null) {
      const needle = range[1].toLowerCase();
      const a = Number(range[2]);
      const b = Number(range[3] ?? range[2]);
      const candidates = needle === "" ? files.slice(0, 3) : files.filter((f) => f.path.toLowerCase().includes(needle)).slice(0, 5);
      groups.push(candidates.map((f) => {
        const ref: MentionRef = { kind: "range", reviewId: row.id, path: f.path, startLine: Math.min(a, b), endLine: Math.max(a, b), side: "new" };
        return scored(ref, mentionLabel(ref), f.path, "Code", 100);
      }));
    }

    const maxChanged = Math.max(1, ...files.map((f) => f.additions + f.deletions));
    const fileItems: ScoredItem[] = [];
    for (const f of files) {
      const s = Math.max(matchScore(baseName(f.path), query, 10), matchScore(f.path, query, 6, true));
      if (s === 0) continue;
      fileItems.push(scored({ kind: "file", reviewId: row.id, path: f.path }, baseName(f.path), `${f.path} · +${f.additions} -${f.deletions}`, "Code", s + ((f.additions + f.deletions) / maxChanged) * 2));
    }
    groups.push(fileItems);

    const symbolItems: ScoredItem[] = [];
    for (const sym of changedSymbols(row)) {
      const s = Math.max(matchScore(sym.qualified.split("::").pop() ?? sym.qualified, query, 9), matchScore(sym.qualified, query, 5));
      if (s === 0) continue;
      // Removed symbols only exist on the base side.
      const removed = sym.status === "removed" && sym.oldStart !== null && sym.oldEnd !== null;
      const ref: MentionRef = removed
        ? { kind: "symbol", reviewId: row.id, path: sym.path, qualified: sym.qualified, startLine: sym.oldStart ?? 1, endLine: sym.oldEnd ?? 1, side: "old" }
        : { kind: "symbol", reviewId: row.id, path: sym.path, qualified: sym.qualified, startLine: sym.start, endLine: sym.end, side: "new" };
      symbolItems.push(scored(ref, sym.qualified, `${sym.kind} ${sym.status} · ${sym.path}:${ref.startLine}-${ref.endLine}${removed ? " (base)" : ""}`, "Workflow", s + Math.min(sym.changedLines, 200) / 100 + Math.min(sym.fanIn, 50) / 50));
    }
    groups.push(symbolItems);

    const threadItems: ScoredItem[] = [];
    for (const t of cachedThreads(row)) {
      const first = t.comments[0];
      if (first === undefined) continue;
      const s = Math.max(matchScore(first.author, query, 6), matchScore(baseName(t.path), query, 4), matchScore(first.body.slice(0, 300), query, 3));
      if (s === 0) continue;
      const ref: MentionRef = { kind: "thread", reviewId: row.id, threadId: t.id };
      threadItems.push(scored(ref, mentionLabel(ref, { author: first.author, path: t.path, line: t.line ?? t.originalLine }), `${t.isResolved ? "resolved" : "open"} · ${first.body.replace(/\s+/g, " ").slice(0, 80)}`, "MessageSquare", s - (t.isResolved ? 2 : 0)));
    }
    groups.push(threadItems);

    const prScore = Math.max(matchScore("pr description", query, 8), matchScore("description", query, 8), matchScore(row.title, query, 4));
    groups.push(prScore > 0 ? [scored({ kind: "pr", reviewId: row.id }, "PR description", row.title, "Info", prScore)] : []);

    // Browsing (empty query) shows a mix; a query ranks everything together.
    const caps = browsing ? [3, 8, 6, 4, 1] : [5, 40, 40, 40, 1];
    const items = groups.flatMap((group, i) => group.sort((a, b) => b.score - a.score).slice(0, caps[i]));
    if (!browsing) items.sort((a, b) => b.score - a.score);
    return items.slice(0, 24).map(({ score: _score, ...rest }) => rest);
  }

  async function mentionResolve(itemId: string): Promise<string> {
    const ref = decodeMentionRef(itemId);
    if (ref === null) throw new Error("unknown code pill");
    const row = requireReview(ref.reviewId);
    const prefix = `${row.owner}/${row.repo}#${row.number}`;
    const short = (sha: string) => sha.slice(0, 10);
    switch (ref.kind) {
      case "range": {
        const startLine = Math.min(ref.startLine, ref.endLine);
        const endLine = Math.max(ref.startLine, ref.endLine);
        return [
          `${prefix} — ${ref.path} lines ${startLine}-${endLine} (${ref.side === "old" ? `base ${short(row.base_sha)}` : `head ${short(row.head_sha)}`}). Lines marked > are the ones the reviewer selected; the rest is surrounding context.`,
          "```",
          await excerpt(row, { path: ref.path, startLine, endLine, side: ref.side }),
          "```",
        ].join("\n");
      }
      case "file": {
        const file = (await filesFor(row)).find((f) => f.path === ref.path) ?? null;
        const result = await host.call("git_patch", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path: ref.path, oldPath: file?.oldPath ?? null }, hostOptions(row));
        const lines = result.patch.split("\n");
        const MAX = 400;
        const body = lines.length > MAX
          ? [...lines.slice(0, MAX), `... ${lines.length - MAX} more diff lines. Ask about a range with path:start-end, or run: git diff ${row.base_sha} ${row.head_sha} -- ${ref.path}`].join("\n")
          : result.patch;
        return [`${prefix} — diff of ${ref.path}${file ? ` (${file.status}, +${file.additions} -${file.deletions})` : ""} from ${short(row.base_sha)} to ${short(row.head_sha)}:`, "```diff", body, "```"].join("\n");
      }
      case "symbol": {
        const file = (await filesFor(row)).find((f) => f.path === ref.path);
        const shown = await host.call(
          "git_show",
          { worktree: row.worktree, sha: ref.side === "old" ? row.base_sha : row.head_sha, path: ref.side === "old" ? file?.oldPath ?? ref.path : ref.path },
          hostOptions(row),
        );
        const lines = (shown.content ?? "").split("\n");
        const start = Math.max(1, ref.startLine);
        const end = Math.min(lines.length, Math.max(start, ref.endLine));
        const MAX = 250;
        const slice = lines.slice(start - 1, Math.min(end, start - 1 + MAX));
        const width = String(end).length;
        const sym = changedSymbols(row).find((s) => s.path === ref.path && s.qualified === ref.qualified);
        return [
          `${prefix} — ${ref.qualified}${sym ? ` (${sym.kind}, ${sym.status}, ${sym.changedLines} changed lines, fan-in ${sym.fanIn})` : ""} in ${ref.path} lines ${start}-${end} at ${ref.side === "old" ? `base ${short(row.base_sha)}` : `head ${short(row.head_sha)}`}:`,
          "```",
          slice.map((line, i) => `${String(start + i).padStart(width)}| ${line}`).join("\n"),
          ...(end - start + 1 > MAX ? [`... truncated after ${MAX} lines; read the file for the rest`] : []),
          "```",
        ].join("\n");
      }
      case "thread": {
        const thread = cachedThreads(row).find((t) => t.id === ref.threadId);
        if (thread === undefined) throw new Error("that review thread is not cached; press Sync and try again");
        const line = thread.line ?? thread.originalLine;
        const parts = [`${prefix} — GitHub review thread on ${thread.path}${line === null ? "" : `:${line}`} (${thread.isResolved ? "resolved" : "open"}${thread.isOutdated ? ", outdated" : ""}, ${thread.side === "LEFT" ? "base" : "head"} side):`];
        for (const c of thread.comments) parts.push(`--- @${c.author} (${c.createdAt}):`, c.body.trim());
        if (line !== null) {
          parts.push("", "Code at that line:", "```", await excerpt(row, { path: thread.path, startLine: line, endLine: line, side: thread.side === "LEFT" ? "old" : "new" }), "```");
        }
        return parts.join("\n");
      }
      case "pr":
        return [`${prefix}: ${row.title}`, `by ${row.author ?? "unknown"} · ${row.base_ref} ← ${row.head_ref} · ${row.state}`, "", row.body.trim() === "" ? "(no description)" : row.body.trim().slice(0, 12_000)].join("\n");
    }
  }

  bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER_ID,
    label: "This PR",
    search: (ctx) => mentionSearch(ctx),
    resolve: async (itemId) => ({ context: await mentionResolve(itemId) }),
  });

  // -- helper thread: one-shot jobs in the PR worktree -----------------------
  //
  // A hidden thread per review that takes one job per message and answers
  // with a single fenced block. Used for the brief; kept separate from the
  // chat seats so the conversation stays the reviewer's.

  function helperIntro(row: ReviewRow): string {
    return [
      `You are the helper for pull request #${row.number} of ${row.owner}/${row.repo}: "${row.title}". You get one job per message. Each job names the fenced block tag it wants; answer with exactly one fenced block of that tag containing JSON, and nothing else before or after it.`,
      `Your working directory is a detached worktree at the PR head ${row.head_sha}; the merge base with ${row.base_ref} is ${row.base_sha}. Full diff: git diff ${row.base_sha} ${row.head_sha}. One file: git diff ${row.base_sha} ${row.head_sha} -- <path>. Base version: git show ${row.base_sha}:<path>.`,
      "You are read-only: never modify files, never commit, never push. Read the code before writing; every line number you cite must exist in the diff.",
    ].join("\n");
  }

  async function helperSend(row: ReviewRow, job: string, text: string): Promise<void> {
    const existing = q.helper.get(row.id);
    if (existing !== undefined) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: existing.thread_id });
        if (thread.archivedAt === null && thread.deletedAt === null) {
          q.setHelperJob.run(job, row.id);
          await bb.sdk.threads.send({ threadId: existing.thread_id, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
          return;
        }
      } catch {
        // stale helper; respawn below
      }
      q.deleteHelper.run(row.id);
    }
    const providerId = existing?.provider_id ?? defaultProvider;
    const providers = await bb.sdk.providers.list();
    const provider = providers.find((p) => p.id === providerId);
    if (provider === undefined) throw new Error(`unknown provider ${providerId}`);
    const modes = provider.capabilities.permissionModes;
    const permissionMode = modes.includes("auto") ? "auto" : modes.includes("accept-edits") ? "accept-edits" : undefined;
    const knownEnvironment = row.environment_id ?? q.seats.all(row.id).find((s) => s.environment_id !== null)?.environment_id ?? null;
    const now = Date.now();
    const thread = await bb.sdk.threads.spawn({
      projectId: await chatProjectId(row),
      environment: knownEnvironment !== null
        ? { type: "reuse", environmentId: knownEnvironment }
        : { type: "host", hostId: row.host_id, workspace: { type: "unmanaged", path: row.worktree } },
      providerId,
      ...(permissionMode ? { permissionMode } : {}),
      title: `Review Desk ${row.owner}/${row.repo}#${row.number}: helper`,
      visibility: hideSeatThreads ? "hidden" : "visible",
      input: [{ type: "text", text: helperIntro(row), mentions: [], visibility: "agent-only" }, { type: "text", text, mentions: [] }],
    });
    q.upsertHelper.run(row.id, thread.id, providerId, knownEnvironment, now);
    q.setHelperJob.run(job, row.id);
    if (knownEnvironment === null) {
      void (async () => {
        const environmentId = thread.environmentId ?? (await waitForEnvironment(thread.id));
        if (environmentId !== null) {
          q.setEnvironment.run(environmentId, row.id);
          q.upsertHelper.run(row.id, thread.id, providerId, environmentId, now);
        }
      })();
    }
  }

  function extractFenced(text: string, tag: string): string | null {
    const fenced = new RegExp("```" + tag + "[^\\n]*\\n([\\s\\S]*?)```", "i").exec(text) ?? /```json[^\n]*\n([\s\S]*?)```/i.exec(text);
    if (fenced !== null) return fenced[1];
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    return start !== -1 && end > start ? text.slice(start, end + 1) : null;
  }

  // -- brief: slop signals + plain-English summary ---------------------------

  const signalRuns = new Set<string>();

  function briefState(row: ReviewRow): BriefState {
    const b = q.brief.get(row.id);
    const signalsCurrent = b !== undefined && b.head_sha === row.head_sha;
    const signalsStatus = signalRuns.has(row.id) ? "computing" : !signalsCurrent ? "missing" : b.signals_status === "ready" || b.signals_status === "failed" ? b.signals_status : "missing";
    const briefStatus = b === undefined ? "missing" : b.brief_status === "writing" || b.brief_status === "ready" || b.brief_status === "failed" ? b.brief_status : "missing";
    return {
      headSha: row.head_sha,
      signalsStatus,
      signals: signalsCurrent && b.signals_status === "ready" ? parseJson<Record<string, unknown> | null>(b.signals_json, null) : null,
      signalsError: signalsCurrent ? b.signals_error : null,
      briefStatus,
      brief: b?.brief_status === "ready" ? parseJson<Record<string, unknown> | null>(b.brief_json, null) : null,
      briefError: b?.brief_error ?? null,
      stale: b?.brief_status === "ready" && b.brief_head_sha !== row.head_sha,
      updatedAt: b?.updated_at ?? null,
    };
  }

  async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i]);
        }
      }),
    );
    return out;
  }

  function startSignals(row: ReviewRow): void {
    if (signalRuns.has(row.id)) return;
    signalRuns.add(row.id);
    q.ensureBrief.run(row.id, row.head_sha, Date.now());
    publish(row.id, "brief");
    void (async () => {
      try {
        const files = (await filesFor(row)).filter((f) => !f.binary && f.additions + f.deletions > 0);
        const patches = new Map<string, string>();
        await mapLimit(files, 8, async (f) => {
          const result = await host.call("git_patch", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path: f.path, oldPath: f.oldPath }, hostOptions(row));
          patches.set(f.path, result.patch);
        });
        const codemap = codemapState(row);
        const moduleOf = codemap.status === "ready" && codemap.codemap !== null ? new Map(codemap.codemap.files.map((f) => [f.path, f.module])) : null;
        const report = computeSlop({ files: await filesFor(row), patches, title: row.title, body: row.body, moduleOf });
        q.setSignals.run(row.head_sha, "ready", JSON.stringify(report), null, Date.now(), row.id);
      } catch (cause) {
        q.setSignals.run(row.head_sha, "failed", null, errorMessage(cause), Date.now(), row.id);
      } finally {
        signalRuns.delete(row.id);
        publish(row.id, "brief");
      }
    })();
  }

  function signalsSummary(report: SlopReport | null): string {
    if (report === null) return "(not computed)";
    if (report.signals.length === 0) return "none";
    return report.signals.map((s) => `- ${s.label} (${s.count}): ${s.evidence.slice(0, 3).map((e) => (e.line === null ? e.note : `${e.path}:${e.line} ${e.note}`)).join("; ")}`).join("\n");
  }

  function codemapDigest(row: ReviewRow): string {
    const state = codemapState(row);
    if (state.status !== "ready" || state.codemap === null) return "(codemap not built yet)";
    const c = state.codemap;
    return [
      "Reading order:",
      ...c.readingOrder.map((m, i) => `  ${i + 1}. ${m.module} (${m.paths.length} files): ${m.reason}`),
      "Hotspots:",
      ...c.hotspots.slice(0, 10).map((h) => `  ${h.path}#${h.qualified} (${h.changedLines} changed lines, fan-in ${h.fanIn})`),
      "Changed symbols (top 60 by changed lines):",
      ...[...changedSymbols(row)].sort((a, b) => b.changedLines - a.changedLines).slice(0, 60).map((s) => `  ${s.status.padEnd(8)} ${s.kind.padEnd(9)} ${s.qualified}  ${s.path}:${s.status === "removed" ? `${s.oldStart}-${s.oldEnd} (base)` : `${s.start}-${s.end}`}`),
    ].join("\n");
  }

  async function briefPrompt(row: ReviewRow): Promise<string> {
    const files = await filesFor(row);
    const state = briefState(row);
    const report = state.signals as unknown as SlopReport | null;
    return [
      `Job: write the brief for this PR. Reply with exactly one fenced block tagged ${BRIEF_FENCE} containing this JSON:`,
      "{",
      '  "summary": string,',
      '  "areas": [{ "module": string, "what": string, "path": string }],',
      '  "claims": [{ "claim": string, "verdict": "matches" | "partly" | "no-evidence" | "contradicted", "evidence": [{ "path": string, "line": number }], "note": string }],',
      '  "ai": { "score": number, "reasons": [{ "reason": string, "evidence": [{ "path": string, "line": number }] }] }',
      "}",
      "",
      "summary: plain English for a reader who knows this codebase but has not read the diff. Say what the code does now that it did not do before, and what changes for callers or operators. 5 to 10 sentences, each under 20 words, active voice, everyday words. Name code by its identifiers. No marketing words (robust, seamless, comprehensive, leverage, enhance). Describe the diff, not the description.",
      "areas: one entry per module touched, at most 8, what changed there in one sentence, path = the file that matters most.",
      "claims: every concrete claim the PR description makes, at most 12. Check each against the diff and the code. verdict: matches, partly, no-evidence (the diff has nothing for it), or contradicted. evidence: head line numbers in changed files. note: one sentence when the verdict is not matches, else empty.",
      "ai.score: how much this PR reads like unedited AI output, 0 = clearly written and edited by a person, 100 = raw generation. Judge the comments, naming, defensive noise, tests, and description shape from the code itself. Give exactly 3 reasons with evidence lines. The deterministic signals below are for orientation; verify before agreeing with them.",
      "",
      `Deterministic signals (score ${report?.score ?? "n/a"}):`,
      signalsSummary(report),
      "",
      `PR title: ${row.title}`,
      "PR description:",
      row.body.trim() === "" ? "(none)" : row.body.trim().slice(0, 8000),
      "",
      `Changed files (${files.length}):`,
      ...files.slice(0, 150).map((f) => `  ${f.status.padEnd(8)} ${f.path} (+${f.additions} -${f.deletions})`),
      ...(files.length > 150 ? [`  ... ${files.length - 150} more`] : []),
      "",
      codemapDigest(row),
    ].join("\n");
  }

  const rawBriefSchema = z.object({
    summary: z.string().optional(),
    areas: z.array(z.object({ module: z.coerce.string(), what: z.string().optional(), path: z.string().nullable().optional() })).optional(),
    claims: z.array(z.object({ claim: z.string(), verdict: z.string().optional(), evidence: z.array(z.object({ path: z.string(), line: z.coerce.number().nullable().optional() })).optional(), note: z.string().nullable().optional() })).optional(),
    ai: z.object({ score: z.coerce.number().optional(), reasons: z.array(z.object({ reason: z.string(), evidence: z.array(z.object({ path: z.string(), line: z.coerce.number().nullable().optional() })).optional() })).optional() }).optional(),
  });

  function normalizeBrief(raw: unknown, files: ChangedFile[]): Brief {
    const parsed = rawBriefSchema.parse(raw);
    const paths = new Set(files.map((f) => f.path));
    const resolvePath = (p: string): string | null => {
      const clean = p.trim().replace(/^\.\//, "");
      if (paths.has(clean)) return clean;
      return files.find((f) => f.path.endsWith(`/${clean}`))?.path ?? null;
    };
    const evidence = (list: { path: string; line?: number | null }[] | undefined): BriefEvidence[] =>
      (list ?? []).slice(0, 6).map((e) => {
        const resolved = resolvePath(e.path);
        return { path: resolved ?? e.path, line: typeof e.line === "number" && e.line > 0 ? Math.round(e.line) : null, found: resolved !== null };
      });
    const verdicts = new Set(["matches", "partly", "no-evidence", "contradicted"]);
    return {
      summary: (parsed.summary ?? "").trim(),
      areas: (parsed.areas ?? []).slice(0, 8).map((a) => ({ module: a.module, what: (a.what ?? "").trim(), path: a.path ? resolvePath(a.path) : null })),
      claims: (parsed.claims ?? []).slice(0, 12).map((c) => ({
        claim: c.claim.trim(),
        verdict: (verdicts.has((c.verdict ?? "").toLowerCase()) ? (c.verdict ?? "").toLowerCase() : "no-evidence") as Brief["claims"][number]["verdict"],
        evidence: evidence(c.evidence),
        note: (c.note ?? "").trim(),
      })),
      ai: {
        score: Math.max(0, Math.min(100, Math.round(parsed.ai?.score ?? 0))),
        reasons: (parsed.ai?.reasons ?? []).slice(0, 4).map((r) => ({ reason: r.reason.trim(), evidence: evidence(r.evidence) })),
      },
    };
  }

  async function writeBrief(row: ReviewRow): Promise<void> {
    q.ensureBrief.run(row.id, row.head_sha, Date.now());
    const current = q.brief.get(row.id);
    if (current?.brief_status === "writing") return;
    q.setBrief.run("writing", row.head_sha, null, null, null, Date.now(), row.id);
    publish(row.id, "brief");
    try {
      await helperSend(row, "brief", await briefPrompt(row));
    } catch (cause) {
      q.setBrief.run("failed", row.head_sha, null, null, errorMessage(cause), Date.now(), row.id);
      publish(row.id, "brief");
    }
  }

  async function completeBrief(reviewId: string, text: string | null, error: string | null): Promise<void> {
    const row = q.review.get(reviewId);
    const current = q.brief.get(reviewId);
    if (row === undefined || current === undefined || current.brief_status !== "writing") return;
    if (error !== null || text === null) {
      q.setBrief.run("failed", current.brief_head_sha, null, text, error ?? "the helper returned nothing", Date.now(), reviewId);
    } else {
      try {
        const json = extractFenced(text, BRIEF_FENCE);
        if (json === null) throw new Error(`no ${BRIEF_FENCE} block in the reply`);
        const brief = normalizeBrief(JSON.parse(json), await filesFor(row));
        if (brief.summary === "") throw new Error("the brief has no summary");
        q.setBrief.run("ready", current.brief_head_sha, JSON.stringify(brief), text, null, Date.now(), reviewId);
      } catch (cause) {
        q.setBrief.run("failed", current.brief_head_sha, null, text, `could not read the brief: ${errorMessage(cause)}`, Date.now(), reviewId);
      }
    }
    publish(reviewId, "brief");
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const helper = q.helperByThread.get(thread.id);
    if (helper === undefined) return;
    if (helper.job === "brief") void completeBrief(helper.review_id, lastAssistantText, null);
    q.setHelperJob.run(null, helper.review_id);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    const helper = q.helperByThread.get(thread.id);
    if (helper === undefined) return;
    if (helper.job === "brief") void completeBrief(helper.review_id, null, error ?? "the helper thread failed");
    q.setHelperJob.run(null, helper.review_id);
  });

  /** Signals for the head, computing when missing or on refresh; the brief starts once per review when autoBrief is on. Rewrites go through brief_write. */
  function briefGet(row: ReviewRow, refresh: boolean): BriefState {
    const state = briefState(row);
    if (refresh || state.signalsStatus === "missing") startSignals(row);
    if (autoBrief && state.briefStatus === "missing") void writeBrief(row);
    return briefState(row);
  }

  // -- GitHub write paths ----------------------------------------------------

  async function submitReview(reviewId: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<{ url: string | null; posted: number }> {
    const row = requireReview(reviewId);
    const pending = q.pending.all(row.id);
    if (pending.length === 0 && body.trim() === "") throw new Error("nothing to submit: add comments or a review body");
    const result = await host.call(
      "gh_submit_review",
      {
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        commitId: row.head_sha,
        event,
        body,
        comments: pending.map((p) => ({ path: p.path, line: p.line, side: p.side === "LEFT" ? "LEFT" : "RIGHT", startLine: p.start_line, body: p.body })),
      },
      hostOptions(row),
    );
    q.clearPending.run(row.id);
    await refreshThreads(row).catch(() => undefined);
    publish(row.id, "pending");
    return { url: result.url, posted: pending.length };
  }

  // -- Roundtable bridge over loopback --------------------------------------

  async function roundtableRpc<T>(method: string, input: unknown): Promise<T> {
    const response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/plugins/roundtable/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; error?: { message?: string } };
    if (!payload.ok) throw new Error(payload.error?.message ?? `roundtable ${method} failed`);
    return payload.result as T;
  }

  // -- RPC -------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    reviews_list: () => ({
      reviews: q.reviews.all().map((row) => ({
        id: row.id,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        title: row.title,
        state: row.state,
        headSha: row.head_sha,
        pendingCount: q.pending.all(row.id).length,
        updatedAt: row.updated_at,
      })),
    }),
    reviews_open: async ({ ref }) => ({ review: await openReview(ref) }),
    reviews_get: ({ reviewId }) => reviewDetail(reviewId),
    reviews_sync: ({ reviewId }) => syncReview(reviewId),
    reviews_remove: async ({ reviewId }) => {
      for (const seat of q.seats.all(reviewId)) await chatReset(reviewId, seat.provider_id);
      q.deleteReview.run(reviewId);
      publish(reviewId, "removed");
      return { ok: true as const };
    },
    review_patch: async ({ reviewId, path }) => {
      const row = requireReview(reviewId);
      const files = await filesFor(row);
      const file = files.find((f) => f.path === path) ?? null;
      const result = await host.call("git_patch", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path, oldPath: file?.oldPath ?? null }, hostOptions(row));
      return { patch: result.patch, file };
    },
    review_file: async ({ reviewId, path, side }) => {
      const row = requireReview(reviewId);
      const files = await filesFor(row);
      const file = files.find((f) => f.path === path);
      const targetPath = side === "old" ? file?.oldPath ?? path : path;
      return host.call("git_show", { worktree: row.worktree, sha: side === "old" ? row.base_sha : row.head_sha, path: targetPath }, hostOptions(row));
    },
    review_conversation: async ({ reviewId, refresh }) => {
      const row = requireReview(reviewId);
      const cache = q.conversationCache.get(row.id);
      if (cache !== undefined && !refresh) {
        return { ...parseJson<{ comments: []; reviews: [] }>(cache.json, { comments: [], reviews: [] }), fetchedAt: cache.fetched_at };
      }
      const result = await host.call("gh_conversation", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
      q.setConversationCache.run(row.id, JSON.stringify(result), Date.now());
      return { ...result, fetchedAt: Date.now() };
    },
    review_threads_refresh: async ({ reviewId }) => ({ threads: await refreshThreads(requireReview(reviewId)) }),
    viewed_set: ({ reviewId, path, viewed }) => {
      if (viewed) q.setViewed.run(reviewId, path, Date.now());
      else q.unsetViewed.run(reviewId, path);
      publish(reviewId, "viewed");
      return { ok: true as const };
    },
    pending_add: ({ reviewId, path, line, startLine, side, body }) => {
      requireReview(reviewId);
      const id = newId();
      q.insertPending.run(id, reviewId, path, line, startLine ?? null, side, body, Date.now());
      publish(reviewId, "pending");
      const row = q.pendingById.get(id);
      if (row === undefined) throw new Error("pending vanished");
      return { pending: toPending(row) };
    },
    pending_update: ({ id, body }) => {
      q.updatePending.run(body, id);
      const row = q.pendingById.get(id);
      if (row === undefined) throw new Error("pending comment not found");
      publish(row.review_id, "pending");
      return { pending: toPending(row) };
    },
    pending_delete: ({ id }) => {
      const row = q.pendingById.get(id);
      q.deletePending.run(id);
      if (row !== undefined) publish(row.review_id, "pending");
      return { ok: true as const };
    },
    review_submit: ({ reviewId, event, body }) => submitReview(reviewId, event, body),
    thread_reply: async ({ reviewId, commentId, body }) => {
      const row = requireReview(reviewId);
      await host.call("gh_reply", { owner: row.owner, repo: row.repo, number: row.number, commentId, body }, hostOptions(row));
      await refreshThreads(row);
      return { ok: true as const };
    },
    thread_resolve: async ({ reviewId, threadId, resolve }) => {
      const row = requireReview(reviewId);
      await host.call("gh_resolve", { threadId, resolve }, hostOptions(row));
      await refreshThreads(row);
      return { ok: true as const };
    },
    chat_send: async ({ reviewId, providerId, model, text, selection }) => ({ seat: await chatSend(reviewId, providerId, model ?? null, text, selection ?? null) }),
    chat_start: async ({ reviewId, providerId, model, reasoningLevel, permissionMode, serviceTier, executionInputSources, input }) => {
      const row = requireReview(reviewId);
      // The composer already validated these against the provider catalog; the
      // SDK types are stricter than our wire schema, so narrow here.
      const execution = {
        ...(model === undefined ? {} : { model }),
        ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(serviceTier === undefined ? {} : { serviceTier }),
        ...(executionInputSources === undefined ? {} : { executionInputSources }),
      } as SpawnExecution;
      return { seat: await deliver(row, providerId, execution, input as unknown as PromptBlocks) };
    },
    seat_lookup: ({ threadId }) => {
      const seat = q.seatByThread.get(threadId);
      return { seat: seat === undefined ? null : { reviewId: seat.review_id, providerId: seat.provider_id } };
    },
    chat_reset: async ({ reviewId, providerId }) => {
      await chatReset(reviewId, providerId);
      return { ok: true as const };
    },
    codemap_get: ({ reviewId, refresh }) => {
      const row = requireReview(reviewId);
      const state = codemapState(row);
      if (refresh || state.status === "missing") startCodemap(row);
      return codemapState(row);
    },
    brief_get: ({ reviewId, refresh }) => briefGet(requireReview(reviewId), refresh === true),
    brief_write: async ({ reviewId }) => {
      const row = requireReview(reviewId);
      if (briefState(row).signalsStatus === "missing") startSignals(row);
      await writeBrief(row);
      return briefState(row);
    },
    rooms_list: async () => {
      try {
        const result = await roundtableRpc<{ rooms: { id: string; title: string; handles: string[] }[] }>("rooms_list", null);
        return { rooms: result.rooms.map((r) => ({ id: r.id, title: r.title, handles: r.handles })), available: true };
      } catch {
        return { rooms: [], available: false };
      }
    },
    send_to_room: async ({ roomId, text, tags, turns }) => {
      await roundtableRpc("rooms_post", { roomId, text, tags, ...(turns === undefined ? {} : { turns }) });
      return { ok: true as const };
    },
    context_providers: async () => {
      const providers = await bb.sdk.providers.list();
      const options = await Promise.all(
        providers.map(async (provider) => {
          let models: ProviderOption["models"] = [];
          if (provider.available) {
            try {
              const result = await bb.sdk.providers.models({ providerId: provider.id });
              models = result.models.filter((m) => (m.routeProviderId ?? provider.id) === provider.id).map((m) => ({ model: m.model, displayName: m.displayName, isDefault: m.isDefault }));
            } catch {
              models = [];
            }
          }
          return { id: provider.id, displayName: provider.displayName, available: provider.available, models };
        }),
      );
      options.sort((a, b) => Number(b.id === defaultProvider) - Number(a.id === defaultProvider));
      return { providers: options, defaultProvider };
    },
  });

  // -- CLI -------------------------------------------------------------------

  bb.cli.register({
    name: "review-desk",
    summary: "Open GitHub pull requests in Review Desk and chat with the PR analyst",
    commands: [
      { name: "open", summary: "Open or refresh a PR review", usage: "bb review-desk open <url | owner/repo#N>" },
      { name: "list", summary: "List reviews", usage: "bb review-desk list [--json]" },
      { name: "ask", summary: "Send a message to the PR analyst", usage: "bb review-desk ask <reviewId> <text...> [--provider <id>]" },
      { name: "codemap", summary: "Build or print the codemap", usage: "bb review-desk codemap <reviewId> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const flag = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
      };
      const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
      const [command, ...rest] = positional;
      const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      try {
        switch (command) {
          case "open": {
            const review = await openReview(rest.join(" "));
            return ok(review, `Opened ${review.owner}/${review.repo}#${review.number} "${review.title}" as ${review.id} (${review.changedFiles} files, worktree ${review.worktree})`);
          }
          case "list": {
            const rows = q.reviews.all();
            return ok(rows.map(toReview), rows.length === 0 ? "No reviews." : rows.map((r) => `${r.id}  ${r.owner}/${r.repo}#${r.number}  ${r.title}  [${r.state}]`).join("\n"));
          }
          case "ask": {
            const [reviewId, ...words] = rest;
            const text = words.join(" ").trim();
            if (!reviewId || text === "") return { exitCode: 1, stderr: "usage: bb review-desk ask <reviewId> <text...> [--provider <id>]" };
            const seat = await chatSend(reviewId, flag("provider") ?? defaultProvider, null, text, null);
            return ok(seat, `Sent to ${seat.providerId} analyst thread ${seat.threadId}`);
          }
          case "codemap": {
            const row = requireReview(rest[0] ?? "");
            let state = codemapState(row);
            if (state.status === "missing" || state.status === "failed") startCodemap(row);
            state = codemapState(row);
            if (state.status !== "ready" || state.codemap === null) return ok(state, `Codemap ${state.status}${state.error ? `: ${state.error}` : ""}. Run again in a moment.`);
            const c = state.codemap;
            const text = [
              `Codemap (${c.engine}) for ${c.headSha.slice(0, 10)}: ${c.stats.files} files, ${c.stats.symbols} symbols (+${c.stats.added} ~${c.stats.modified} -${c.stats.removed})`,
              "Reading order:",
              ...c.readingOrder.map((m, i) => `  ${i + 1}. ${m.module}  (${m.paths.length} files) ${m.reason}`),
              "Hotspots:",
              ...c.hotspots.slice(0, 10).map((h) => `  ${h.score}  ${h.path}#${h.qualified}  (${h.changedLines} lines, fan-in ${h.fanIn})`),
            ].join("\n");
            return ok(c, text);
          }
          default:
            return { exitCode: 1, stderr: "usage: bb review-desk open|list|ask|codemap" };
        }
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
  bb.log.info("loaded");
}
