// bb-plugin-review-desk — server entry.
//
// Owns review records, GitHub caches, pending comments, AI notes and the
// codemap cache in the plugin's SQLite. Talks to the machine that holds the
// repository through the host entry (git, gh, tree-sitter) and to AI seats
// through hidden bb threads spawned into the PR worktree.
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
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

export const AI_KINDS = ["explain", "why", "risks", "fix", "ask", "pass_summary", "pass_risk", "pass_perf", "pass_slop", "pass_tests", "file_summary"] as const;
const aiKindSchema = z.enum(AI_KINDS);
export type AiKind = z.infer<typeof aiKindSchema>;

export const SEVERITIES = ["blocker", "major", "minor", "nit", "info"] as const;
const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

const sideSchema = z.enum(["old", "new"]);
export type Side = z.infer<typeof sideSchema>;

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
  checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() })),
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
  noteCount: z.number(),
  updatedAt: z.number(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

const fileEntrySchema = changedFileSchema.extend({
  viewed: z.boolean(),
  threadCount: z.number(),
  unresolvedCount: z.number(),
  noteCount: z.number(),
  pendingCount: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

const noteSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  requestId: z.string().nullable(),
  kind: z.enum(["answer", "finding", "summary"]),
  severity: severitySchema.nullable(),
  path: z.string().nullable(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  side: sideSchema,
  title: z.string(),
  body: z.string(),
  providerId: z.string(),
  status: z.enum(["draft", "posted", "dismissed"]),
  createdAt: z.number(),
});
export type Note = z.infer<typeof noteSchema>;

const pendingSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  line: z.number(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
  noteId: z.string().nullable(),
  createdAt: z.number(),
});
export type PendingComment = z.infer<typeof pendingSchema>;

const aiRequestSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  providerId: z.string(),
  kind: aiKindSchema,
  path: z.string().nullable(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  side: sideSchema,
  question: z.string().nullable(),
  status: z.enum(["running", "done", "failed"]),
  threadId: z.string().nullable(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type AiRequest = z.infer<typeof aiRequestSchema>;

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
      notes: z.array(noteSchema),
      requests: z.array(aiRequestSchema),
      threads: z.array(ghThreadSchema),
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
      noteId: z.string().nullable().optional(),
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
  ai_ask: {
    input: z.object({
      reviewId: z.string(),
      kind: aiKindSchema,
      providerId: z.string().min(1),
      model: z.string().nullable().optional(),
      path: z.string().nullable().optional(),
      startLine: z.number().int().min(1).nullable().optional(),
      endLine: z.number().int().min(1).nullable().optional(),
      side: sideSchema.optional(),
      question: z.string().max(10_000).nullable().optional(),
    }),
    output: z.object({ request: aiRequestSchema }),
  },
  ai_cancel: { input: z.object({ requestId: z.string() }), output: okSchema },
  note_update: { input: z.object({ id: z.string(), status: z.enum(["draft", "posted", "dismissed"]) }), output: okSchema },
  codemap_get: { input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }), output: codemapStateSchema },
  rooms_list: { input: z.null(), output: z.object({ rooms: z.array(z.object({ id: z.string(), title: z.string(), handles: z.array(z.string()) })), available: z.boolean() }) },
  send_to_room: {
    input: z.object({ roomId: z.string(), text: z.string().trim().min(1).max(20_000), tags: z.array(z.string()).max(8), turns: z.number().int().min(0).max(40).optional() }),
    output: okSchema,
  },
  context_providers: { input: z.null(), output: z.object({ providers: z.array(providerOptionSchema) }) },
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
  `CREATE TABLE IF NOT EXISTS notes (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     request_id TEXT,
     kind TEXT NOT NULL,
     severity TEXT,
     path TEXT,
     start_line INTEGER,
     end_line INTEGER,
     side TEXT NOT NULL DEFAULT 'new',
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notes_review_idx ON notes(review_id)`,
  `CREATE TABLE IF NOT EXISTS pending (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     path TEXT NOT NULL,
     line INTEGER NOT NULL,
     start_line INTEGER,
     side TEXT NOT NULL,
     body TEXT NOT NULL,
     note_id TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seats (review_id TEXT NOT NULL, provider_id TEXT NOT NULL, thread_id TEXT, environment_id TEXT, PRIMARY KEY (review_id, provider_id))`,
  `CREATE TABLE IF NOT EXISTS requests (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     path TEXT,
     start_line INTEGER,
     end_line INTEGER,
     side TEXT NOT NULL DEFAULT 'new',
     question TEXT,
     status TEXT NOT NULL,
     thread_id TEXT,
     created_at INTEGER NOT NULL,
     completed_at INTEGER,
     error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS awaiting (thread_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS codemaps (review_id TEXT PRIMARY KEY, head_sha TEXT NOT NULL, status TEXT NOT NULL, json TEXT, error TEXT, updated_at INTEGER NOT NULL)`,
];

interface ReviewRow {
  id: string; owner: string; repo: string; number: number; title: string; body: string; state: string; is_draft: number; url: string; author: string | null;
  base_ref: string; head_ref: string; head_sha: string; base_sha: string; additions: number; deletions: number; changed_files: number;
  review_decision: string | null; mergeable: string | null; labels_json: string; checks_json: string; worktree: string; environment_id: string | null;
  host_id: string; repo_path: string; project_id: string | null; gh_updated_at: string; synced_at: number; created_at: number; updated_at: number;
}
interface NoteRow {
  id: string; review_id: string; request_id: string | null; kind: string; severity: string | null; path: string | null; start_line: number | null; end_line: number | null;
  side: string; title: string; body: string; provider_id: string; status: string; created_at: number;
}
interface PendingRow { id: string; review_id: string; path: string; line: number; start_line: number | null; side: string; body: string; note_id: string | null; created_at: number }
interface SeatRow { review_id: string; provider_id: string; thread_id: string | null; environment_id: string | null }
interface RequestRow {
  id: string; review_id: string; provider_id: string; kind: string; path: string | null; start_line: number | null; end_line: number | null; side: string;
  question: string | null; status: string; thread_id: string | null; created_at: number; completed_at: number | null; error: string | null;
}
interface CodemapRow { review_id: string; head_sha: string; status: string; json: string | null; error: string | null; updated_at: number }
interface CacheRow { review_id: string; json: string; fetched_at: number }

function newId(): string {
  return randomBytes(6).toString("hex");
}

function createStore(db: Database.Database) {
  const q = {
    reviews: db.prepare<[], ReviewRow>(`SELECT * FROM reviews ORDER BY updated_at DESC`),
    review: db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE id = ?`),
    reviewByKey: db.prepare<[string, string, number], ReviewRow>(`SELECT * FROM reviews WHERE owner = ? AND repo = ? AND number = ?`),
    insertReview: db.prepare<[string, string, string, number, string, string, string, number, string, string | null, string, string, string, string, number, number, number, string | null, string | null, string, string, string, string, string, string | null, string, number, number, number]>(
      `INSERT INTO reviews (id, owner, repo, number, title, body, state, is_draft, url, author, base_ref, head_ref, head_sha, base_sha, additions, deletions, changed_files, review_decision, mergeable, labels_json, checks_json, worktree, host_id, repo_path, project_id, gh_updated_at, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateReviewMeta: db.prepare<[string, string, string, number, string | null, string, string, string, string, number, number, number, string | null, string | null, string, string, string, string, number, number, string]>(
      `UPDATE reviews SET title = ?, body = ?, state = ?, is_draft = ?, author = ?, base_ref = ?, head_ref = ?, head_sha = ?, base_sha = ?, additions = ?, deletions = ?, changed_files = ?, review_decision = ?, mergeable = ?, labels_json = ?, checks_json = ?, worktree = ?, gh_updated_at = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
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
    notes: db.prepare<[string], NoteRow>(`SELECT * FROM notes WHERE review_id = ? ORDER BY created_at ASC`),
    note: db.prepare<[string], NoteRow>(`SELECT * FROM notes WHERE id = ?`),
    insertNote: db.prepare<[string, string, string | null, string, string | null, string | null, number | null, number | null, string, string, string, string, string, number]>(
      `INSERT INTO notes (id, review_id, request_id, kind, severity, path, start_line, end_line, side, title, body, provider_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setNoteStatus: db.prepare<[string, string]>(`UPDATE notes SET status = ? WHERE id = ?`),
    pending: db.prepare<[string], PendingRow>(`SELECT * FROM pending WHERE review_id = ? ORDER BY created_at ASC`),
    pendingById: db.prepare<[string], PendingRow>(`SELECT * FROM pending WHERE id = ?`),
    insertPending: db.prepare<[string, string, string, number, number | null, string, string, string | null, number]>(
      `INSERT INTO pending (id, review_id, path, line, start_line, side, body, note_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updatePending: db.prepare<[string, string]>(`UPDATE pending SET body = ? WHERE id = ?`),
    deletePending: db.prepare<[string]>(`DELETE FROM pending WHERE id = ?`),
    clearPending: db.prepare<[string]>(`DELETE FROM pending WHERE review_id = ?`),
    seat: db.prepare<[string, string], SeatRow>(`SELECT * FROM seats WHERE review_id = ? AND provider_id = ?`),
    seats: db.prepare<[string], SeatRow>(`SELECT * FROM seats WHERE review_id = ?`),
    upsertSeat: db.prepare<[string, string, string | null, string | null]>(
      `INSERT INTO seats (review_id, provider_id, thread_id, environment_id) VALUES (?, ?, ?, ?) ON CONFLICT(review_id, provider_id) DO UPDATE SET thread_id = excluded.thread_id, environment_id = excluded.environment_id`,
    ),
    requests: db.prepare<[string], RequestRow>(`SELECT * FROM requests WHERE review_id = ? ORDER BY created_at DESC LIMIT 50`),
    request: db.prepare<[string], RequestRow>(`SELECT * FROM requests WHERE id = ?`),
    insertRequest: db.prepare<[string, string, string, string, string | null, number | null, number | null, string, string | null, string, string | null, number]>(
      `INSERT INTO requests (id, review_id, provider_id, kind, path, start_line, end_line, side, question, status, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setRequestThread: db.prepare<[string, string]>(`UPDATE requests SET thread_id = ? WHERE id = ?`),
    finishRequest: db.prepare<[string, number, string | null, string]>(`UPDATE requests SET status = ?, completed_at = ?, error = ? WHERE id = ?`),
    awaitingAll: db.prepare<[], { thread_id: string; request_id: string }>(`SELECT * FROM awaiting`),
    setAwaiting: db.prepare<[string, string]>(`INSERT OR REPLACE INTO awaiting (thread_id, request_id) VALUES (?, ?)`),
    deleteAwaiting: db.prepare<[string]>(`DELETE FROM awaiting WHERE thread_id = ?`),
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
    worktree: row.worktree,
    environmentId: row.environment_id,
    hostId: row.host_id,
    syncedAt: row.synced_at,
    ghUpdatedAt: row.gh_updated_at,
  };
}

function isSeverity(value: string | null): value is Severity {
  return value !== null && (SEVERITIES as readonly string[]).includes(value);
}
function isAiKind(value: string): value is AiKind {
  return (AI_KINDS as readonly string[]).includes(value);
}
function isSide(value: string): value is Side {
  return value === "old" || value === "new";
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    reviewId: row.review_id,
    requestId: row.request_id,
    kind: row.kind === "finding" || row.kind === "summary" ? row.kind : "answer",
    severity: isSeverity(row.severity) ? row.severity : null,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    side: isSide(row.side) ? row.side : "new",
    title: row.title,
    body: row.body,
    providerId: row.provider_id,
    status: row.status === "posted" || row.status === "dismissed" ? row.status : "draft",
    createdAt: row.created_at,
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
    noteId: row.note_id,
    createdAt: row.created_at,
  };
}

function toRequest(row: RequestRow): AiRequest {
  return {
    id: row.id,
    reviewId: row.review_id,
    providerId: row.provider_id,
    kind: isAiKind(row.kind) ? row.kind : "ask",
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    side: isSide(row.side) ? row.side : "new",
    question: row.question,
    status: row.status === "done" || row.status === "failed" ? row.status : "running",
    threadId: row.thread_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    error: row.error,
  };
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

const FINDINGS_RE = /```findings\s*\n([\s\S]*?)```/i;

interface ParsedFinding {
  severity: Severity;
  path: string | null;
  line: number | null;
  side: Side;
  title: string;
  body: string;
}

function parseFindings(text: string): { prose: string; findings: ParsedFinding[] } {
  const match = text.match(FINDINGS_RE);
  if (!match) return { prose: text.trim(), findings: [] };
  const prose = text.replace(FINDINGS_RE, "").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return { prose: text.trim(), findings: [] };
  }
  if (!Array.isArray(raw)) return { prose, findings: [] };
  const findings: ParsedFinding[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    const severity = typeof f.severity === "string" && isSeverity(f.severity) ? f.severity : "info";
    const line = typeof f.line === "number" && Number.isFinite(f.line) && f.line > 0 ? Math.round(f.line) : null;
    findings.push({
      severity,
      path: typeof f.path === "string" && f.path !== "" ? f.path : null,
      line,
      side: f.side === "old" ? "old" : "new",
      title: typeof f.title === "string" ? f.title.slice(0, 200) : "Finding",
      body: typeof f.body === "string" ? f.body : "",
    });
  }
  return { prose, findings };
}

const KIND_INSTRUCTIONS: Record<AiKind, string> = {
  explain: "Explain what the selected code does and why it is written this way, in the context of the whole PR. Mention anything non-obvious a reviewer should know. Findings block optional.",
  why: "Explain why this change was made: what the base version did, what the head version does differently, and what in the PR motivates it. Use git diff and git show. Findings block optional.",
  risks: "List the risks in the selected code: correctness, concurrency, performance on the hot path, error handling, compatibility. Verify against the code before asserting. Return each risk as a finding with a line number.",
  fix: "Propose a concrete fix for the selected code. Show the changed lines as a fenced diff or code block. Return the proposal as one finding anchored to the selection.",
  ask: "Answer the question about the selected code precisely. Findings block optional.",
  pass_summary: "Summarize the whole PR for a reviewer: purpose, the shape of the change by module, the load-bearing decisions, what to read first. Under 400 words. Return an empty findings block.",
  pass_risk: "Review the whole PR diff for correctness risks: races, lock scope, error paths, invariants, edge cases, silent behavior changes. Verify each against the code. Return findings with exact file and line on the new side; severity honest.",
  pass_perf: "Review the whole PR diff for hot-path performance: allocations, clones, locks, scans, blocking in async, unbounded growth, repeated work. Verify each against the code. Return findings with exact file and line.",
  pass_slop: "Review the whole PR diff for slop: dead code, redundant wrappers, duplicated logic, unnecessary abstractions, test-only surface leaking into production, stale comments, inconsistent naming. Return findings with exact file and line and a concrete cleanup.",
  pass_tests: "Review the PR for test coverage gaps: changed behavior without a test, tests that cannot fail, missing edge cases. Return findings anchored to the untested code.",
  file_summary: "Summarize what changed in this file and why it matters, in under 150 words. Return an empty findings block.",
};

const KIND_TITLES: Record<AiKind, string> = {
  explain: "Explanation",
  why: "Why this changed",
  risks: "Risks",
  fix: "Suggested fix",
  ask: "Answer",
  pass_summary: "PR summary",
  pass_risk: "Risk review",
  pass_perf: "Performance review",
  pass_slop: "Slop review",
  pass_tests: "Test coverage review",
  file_summary: "File summary",
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultProvider: { type: "string", label: "Default AI provider id for analysis", default: "claude-code" },
    hideSeatThreads: { type: "boolean", label: "Hide analyst threads from the sidebar", default: true },
  });
  const { defaultProvider, hideSeatThreads } = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const { q }: Store = createStore(db);
  const host = bb.hosts.experimental_client({ contract: hostContract });

  /** thread id -> request id, mirrored in SQLite so reloads keep in-flight answers. */
  const awaiting = new Map<string, string>(q.awaitingAll.all().map((row) => [row.thread_id, row.request_id]));
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
    q.insertReview.run(
      id, parsed.owner, parsed.repo, parsed.number, pr.title, pr.body, pr.state, pr.isDraft ? 1 : 0, pr.url, pr.author?.login ?? null,
      pr.baseRefName, pr.headRefName, prepared.headSha, prepared.baseSha, pr.additions, pr.deletions, pr.changedFiles,
      pr.reviewDecision, pr.mergeable, JSON.stringify(pr.labels), JSON.stringify(pr.checks), prepared.worktree, located.hostId, located.repoPath, located.projectId,
      pr.updatedAt, now, now, now,
    );
    const row = requireReview(id);
    await refreshFiles(row);
    void refreshThreads(row).catch((cause: unknown) => bb.log.warn(`threads for ${id}: ${errorMessage(cause)}`));
    publish(id, "opened");
    return toReview(row);
  }

  function applyPr(row: ReviewRow, pr: GhPr, prepared: { worktree: string; headSha: string; baseSha: string }): void {
    q.updateReviewMeta.run(
      pr.title, pr.body, pr.state, pr.isDraft ? 1 : 0, pr.author?.login ?? null, pr.baseRefName, pr.headRefName, prepared.headSha, prepared.baseSha,
      pr.additions, pr.deletions, pr.changedFiles, pr.reviewDecision, pr.mergeable, JSON.stringify(pr.labels), JSON.stringify(pr.checks),
      prepared.worktree, pr.updatedAt, Date.now(), Date.now(), row.id,
    );
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
    const notes = q.notes.all(row.id).map(toNote);
    const pending = q.pending.all(row.id).map(toPending);
    const perPath = new Map<string, { threads: number; unresolved: number; notes: number; pending: number }>();
    const bump = (p: string, field: "threads" | "unresolved" | "notes" | "pending") => {
      const entry = perPath.get(p) ?? { threads: 0, unresolved: 0, notes: 0, pending: 0 };
      entry[field]++;
      perPath.set(p, entry);
    };
    for (const t of threads) {
      bump(t.path, "threads");
      if (!t.isResolved) bump(t.path, "unresolved");
    }
    for (const n of notes) if (n.path !== null && n.status === "draft") bump(n.path, "notes");
    for (const p of pending) bump(p.path, "pending");
    return {
      review: toReview(row),
      files: files.map((f) => {
        const counts = perPath.get(f.path) ?? { threads: 0, unresolved: 0, notes: 0, pending: 0 };
        return { ...f, viewed: viewed.has(f.path), threadCount: counts.threads, unresolvedCount: counts.unresolved, noteCount: counts.notes, pendingCount: counts.pending };
      }),
      pending,
      notes,
      requests: q.requests.all(row.id).map(toRequest),
      threads,
    };
  }

  // -- AI seats --------------------------------------------------------------

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
      `You are the Review Desk analyst for pull request #${row.number} of ${row.owner}/${row.repo}: "${row.title}".`,
      `Your working directory is a detached worktree at the PR head ${row.head_sha}. The merge base with ${row.base_ref} is ${row.base_sha}.`,
      `The full diff is: git diff ${row.base_sha} ${row.head_sha}. One file: git diff ${row.base_sha} ${row.head_sha} -- <path>. Base version of a file: git show ${row.base_sha}:<path>.`,
      "You are read-only: never modify files, never commit, never push. Read files and run read-only commands to verify claims before making them.",
      "Each message is one request from the reviewer. Answer for the reviewer, specific to the code. When asked for findings, end with a ```findings JSON block as described in the review-desk skill: severity, path, line (new side unless side is old), title, body. Return [] when there is nothing.",
      "",
      "PR description:",
      row.body.trim() === "" ? "(none)" : row.body.trim().slice(0, 6000),
    ].join("\n");
  }

  async function excerpt(row: ReviewRow, filePath: string, side: Side, start: number, end: number): Promise<string> {
    const sha = side === "old" ? row.base_sha : row.head_sha;
    const result = await host.call("git_show", { worktree: row.worktree, sha, path: filePath }, hostOptions(row));
    if (result.content === null) return "(file content unavailable)";
    const lines = result.content.split("\n");
    const from = Math.max(1, start - 8);
    const to = Math.min(lines.length, end + 8);
    const width = String(to).length;
    return lines
      .slice(from - 1, to)
      .map((line, i) => {
        const n = from + i;
        const marker = n >= start && n <= end ? ">" : " ";
        return `${marker}${String(n).padStart(width)}| ${line}`;
      })
      .join("\n");
  }

  async function buildRequestText(row: ReviewRow, request: RequestRow): Promise<string> {
    const parts: string[] = [`Request ${request.id} (${request.kind}).`];
    if (request.path !== null) {
      const side: Side = isSide(request.side) ? request.side : "new";
      if (request.start_line !== null && request.end_line !== null) {
        parts.push(`Selected: ${request.path} lines ${request.start_line}-${request.end_line} (${side === "old" ? "base" : "head"} side). Excerpt with > marking the selection:`);
        parts.push("```");
        parts.push(await excerpt(row, request.path, side, request.start_line, request.end_line));
        parts.push("```");
      } else {
        parts.push(`File: ${request.path}. Its diff: git diff ${row.base_sha} ${row.head_sha} -- ${request.path}`);
      }
    }
    if (request.question) parts.push(`Question: ${request.question}`);
    parts.push(KIND_INSTRUCTIONS[isAiKind(request.kind) ? request.kind : "ask"]);
    return parts.join("\n");
  }

  async function ensureSeat(row: ReviewRow, providerId: string, model: string | null, firstMessage: string): Promise<{ threadId: string; spawned: boolean }> {
    const seat = q.seat.get(row.id, providerId);
    if (seat?.thread_id) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: seat.thread_id });
        if (thread.archivedAt === null && thread.deletedAt === null) return { threadId: seat.thread_id, spawned: false };
      } catch {
        // fall through and respawn
      }
    }
    const providers = await bb.sdk.providers.list();
    const provider = providers.find((p) => p.id === providerId);
    if (provider === undefined) throw new Error(`unknown provider ${providerId}`);
    const modes = provider.capabilities.permissionModes;
    const permissionMode = modes.includes("auto") ? "auto" : modes.includes("accept-edits") ? "accept-edits" : undefined;
    const knownEnvironment = row.environment_id ?? q.seats.all(row.id).find((s) => s.environment_id !== null)?.environment_id ?? null;
    const projectId = row.project_id ?? (await bb.sdk.projects.list({ includePersonal: true })).find((p) => p.kind !== "standard")?.id;
    if (projectId === undefined) throw new Error("no project to spawn the analyst in");
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: knownEnvironment !== null
        ? { type: "reuse", environmentId: knownEnvironment }
        : { type: "host", hostId: row.host_id, workspace: { type: "unmanaged", path: row.worktree } },
      providerId,
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      title: `Review Desk ${row.owner}/${row.repo}#${row.number}: ${providerId}`,
      visibility: hideSeatThreads ? "hidden" : "visible",
      prompt: `${seatIntro(row)}\n\n${firstMessage}`,
    });
    q.upsertSeat.run(row.id, providerId, thread.id, knownEnvironment);
    if (knownEnvironment === null) {
      const environmentId = thread.environmentId ?? (await waitForEnvironment(thread.id));
      if (environmentId !== null) {
        q.upsertSeat.run(row.id, providerId, thread.id, environmentId);
        q.setEnvironment.run(environmentId, row.id);
      }
    }
    return { threadId: thread.id, spawned: true };
  }

  async function ask(input: { reviewId: string; kind: AiKind; providerId: string; model?: string | null; path?: string | null; startLine?: number | null; endLine?: number | null; side?: Side; question?: string | null }): Promise<AiRequest> {
    const row = requireReview(input.reviewId);
    const id = newId();
    const side: Side = input.side ?? "new";
    q.insertRequest.run(id, row.id, input.providerId, input.kind, input.path ?? null, input.startLine ?? null, input.endLine ?? null, side, input.question ?? null, "running", null, Date.now());
    publish(row.id, "requests");
    void (async () => {
      try {
        const request = q.request.get(id);
        if (request === undefined) return;
        const text = await buildRequestText(row, request);
        const { threadId, spawned } = await ensureSeat(row, input.providerId, input.model ?? null, text);
        q.setRequestThread.run(threadId, id);
        awaiting.set(threadId, id);
        q.setAwaiting.run(threadId, id);
        if (!spawned) {
          await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
        }
        publish(row.id, "requests");
      } catch (cause) {
        q.finishRequest.run("failed", Date.now(), errorMessage(cause), id);
        publish(row.id, "requests");
      }
    })();
    const created = q.request.get(id);
    if (created === undefined) throw new Error("request vanished");
    return toRequest(created);
  }

  function recordAnswer(request: RequestRow, text: string): void {
    const { prose, findings } = parseFindings(text);
    const now = Date.now();
    const isPass = request.kind.startsWith("pass_") || request.kind === "file_summary";
    if (prose !== "") {
      q.insertNote.run(
        newId(), request.review_id, request.id, isPass ? "summary" : "answer", null,
        request.path, request.start_line, request.end_line, request.side,
        request.question ?? KIND_TITLES[isAiKind(request.kind) ? request.kind : "ask"],
        prose, request.provider_id, "draft", now,
      );
    }
    for (const finding of findings) {
      q.insertNote.run(
        newId(), request.review_id, request.id, "finding", finding.severity,
        finding.path ?? request.path, finding.line ?? request.start_line, finding.line ?? request.end_line, finding.side,
        finding.title, finding.body, request.provider_id, "draft", now,
      );
    }
    q.finishRequest.run("done", now, null, request.id);
    q.touch.run(now, request.review_id);
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const requestId = awaiting.get(thread.id);
    if (requestId === undefined) return;
    awaiting.delete(thread.id);
    q.deleteAwaiting.run(thread.id);
    const request = q.request.get(requestId);
    if (request === undefined) return;
    let text = lastAssistantText?.trim() ?? "";
    if (text === "") {
      try {
        text = (await bb.sdk.threads.output({ threadId: thread.id })).output?.trim() ?? "";
      } catch (cause) {
        bb.log.warn(`output for ${thread.id}: ${errorMessage(cause)}`);
      }
    }
    if (text === "") {
      q.finishRequest.run("failed", Date.now(), "empty reply", request.id);
    } else {
      recordAnswer(request, text);
    }
    publish(request.review_id, "notes");
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const requestId = awaiting.get(thread.id);
    if (requestId === undefined) return;
    awaiting.delete(thread.id);
    q.deleteAwaiting.run(thread.id);
    const request = q.request.get(requestId);
    if (request === undefined) return;
    q.finishRequest.run("failed", Date.now(), error ?? "thread failed", request.id);
    publish(request.review_id, "requests");
  });

  bb.events.on("thread.active", ({ thread }) => {
    const requestId = awaiting.get(thread.id);
    if (requestId === undefined) return;
    const request = q.request.get(requestId);
    if (request !== undefined) publish(request.review_id, "requests");
  });

  async function cancelRequest(requestId: string): Promise<void> {
    const request = q.request.get(requestId);
    if (request === undefined || request.status !== "running") return;
    if (request.thread_id !== null) {
      awaiting.delete(request.thread_id);
      q.deleteAwaiting.run(request.thread_id);
      await bb.sdk.threads.stop({ threadId: request.thread_id }).catch(() => undefined);
    }
    q.finishRequest.run("failed", Date.now(), "cancelled", requestId);
    publish(request.review_id, "requests");
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
    for (const p of pending) if (p.note_id !== null) q.setNoteStatus.run("posted", p.note_id);
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
        noteCount: q.notes.all(row.id).filter((n) => n.status === "draft").length,
        updatedAt: row.updated_at,
      })),
    }),
    reviews_open: async ({ ref }) => ({ review: await openReview(ref) }),
    reviews_get: ({ reviewId }) => reviewDetail(reviewId),
    reviews_sync: ({ reviewId }) => syncReview(reviewId),
    reviews_remove: ({ reviewId }) => {
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
      return { ok: true as const };
    },
    pending_add: ({ reviewId, path, line, startLine, side, body, noteId }) => {
      requireReview(reviewId);
      const id = newId();
      q.insertPending.run(id, reviewId, path, line, startLine ?? null, side, body, noteId ?? null, Date.now());
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
    ai_ask: async (input) => ({ request: await ask(input) }),
    ai_cancel: async ({ requestId }) => {
      await cancelRequest(requestId);
      return { ok: true as const };
    },
    note_update: ({ id, status }) => {
      const note = q.note.get(id);
      if (note === undefined) throw new Error("note not found");
      q.setNoteStatus.run(status, id);
      publish(note.review_id, "notes");
      return { ok: true as const };
    },
    codemap_get: ({ reviewId, refresh }) => {
      const row = requireReview(reviewId);
      const state = codemapState(row);
      if (refresh || state.status === "missing") startCodemap(row);
      return codemapState(row);
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
      return { providers: options };
    },
  });

  // -- CLI -------------------------------------------------------------------

  bb.cli.register({
    name: "review-desk",
    summary: "Open GitHub pull requests in Review Desk and run AI analysis passes",
    commands: [
      { name: "open", summary: "Open or refresh a PR review", usage: "bb review-desk open <url | owner/repo#N>" },
      { name: "list", summary: "List reviews", usage: "bb review-desk list [--json]" },
      { name: "pass", summary: "Run an analysis pass", usage: "bb review-desk pass <reviewId> <summary|risk|perf|slop|tests> [--provider <id>]" },
      { name: "notes", summary: "Print AI notes", usage: "bb review-desk notes <reviewId> [--json]" },
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
          case "pass": {
            const [reviewId, pass] = rest;
            const kind = `pass_${pass}`;
            if (!reviewId || !isAiKind(kind)) return { exitCode: 1, stderr: "usage: bb review-desk pass <reviewId> <summary|risk|perf|slop|tests>" };
            const request = await ask({ reviewId, kind, providerId: flag("provider") ?? defaultProvider });
            return ok(request, `Started ${kind} as request ${request.id} on ${request.providerId}`);
          }
          case "notes": {
            const notes = q.notes.all(rest[0] ?? "").map(toNote);
            return ok(notes, notes.length === 0 ? "No notes." : notes.map((n) => `[${n.status}] ${n.severity ?? n.kind} ${n.path ?? ""}${n.startLine ? `:${n.startLine}` : ""} ${n.title}\n  ${n.body.slice(0, 300).replace(/\n/g, "\n  ")}`).join("\n"));
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
            return { exitCode: 1, stderr: "usage: bb review-desk open|list|pass|notes|codemap" };
        }
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
  bb.log.info(`loaded (${awaiting.size} in-flight request(s))`);
}
