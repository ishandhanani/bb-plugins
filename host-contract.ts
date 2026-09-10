// Shared RPC contract between server.ts (client) and host.ts (worker on the
// machine that holds the repository). Everything that touches git, gh, or the
// filesystem of the checkout goes through here.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const changedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unknown"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const ghUserSchema = z.object({ login: z.string() }).nullable();

export const ghPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  author: ghUserSchema,
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefOid: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullable(),
  updatedAt: z.string(),
  checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() })),
  labels: z.array(z.string()),
});
export type GhPr = z.infer<typeof ghPrSchema>;

export const ghCommentSchema = z.object({
  id: z.string(),
  databaseId: z.number().nullable(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string().nullable(),
});
export type GhComment = z.infer<typeof ghCommentSchema>;

export const ghThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  comments: z.array(ghCommentSchema),
});
export type GhThread = z.infer<typeof ghThreadSchema>;

export const ghIssueCommentSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export const ghReviewSchema = z.object({
  id: z.number(),
  author: z.string(),
  state: z.string(),
  body: z.string(),
  submittedAt: z.string().nullable(),
  url: z.string(),
});

export const codemapSymbolSchema = z.object({
  kind: z.string(),
  name: z.string(),
  qualified: z.string(),
  status: z.enum(["added", "removed", "modified", "unchanged"]),
  start: z.number(),
  end: z.number(),
  oldStart: z.number().nullable(),
  oldEnd: z.number().nullable(),
  changedLines: z.number(),
  fanIn: z.number(),
  refs: z.array(z.string()),
});
export type CodemapSymbol = z.infer<typeof codemapSymbolSchema>;

export const codemapSchema = z.object({
  headSha: z.string(),
  engine: z.enum(["tree-sitter", "regex"]),
  files: z.array(
    z.object({
      path: z.string(),
      lang: z.string().nullable(),
      module: z.string(),
      changedLines: z.number(),
      symbols: z.array(codemapSymbolSchema),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  readingOrder: z.array(z.object({ module: z.string(), paths: z.array(z.string()), reason: z.string() })),
  hotspots: z.array(z.object({ path: z.string(), qualified: z.string(), score: z.number(), changedLines: z.number(), fanIn: z.number() })),
  stats: z.object({ files: z.number(), symbols: z.number(), added: z.number(), removed: z.number(), modified: z.number(), parseFailures: z.number() }),
});
export type Codemap = z.infer<typeof codemapSchema>;

export const hostContract = defineRpcContract({
  /** Fetch the PR head and base, and keep a detached worktree at the head. */
  repo_prepare: {
    input: z.object({
      repoPath: z.string(),
      number: z.number(),
      headSha: z.string(),
      baseRefName: z.string(),
      worktreesDir: z.string(),
      key: z.string(),
    }),
    output: z.object({ worktree: z.string(), headSha: z.string(), baseSha: z.string() }),
  },
  repo_clone: {
    input: z.object({ owner: z.string(), repo: z.string(), dest: z.string() }),
    output: z.object({ repoPath: z.string() }),
  },
  git_files: {
    input: z.object({ worktree: z.string(), baseSha: z.string(), headSha: z.string() }),
    output: z.object({ files: z.array(changedFileSchema) }),
  },
  git_patch: {
    input: z.object({ worktree: z.string(), baseSha: z.string(), headSha: z.string(), path: z.string(), oldPath: z.string().nullable() }),
    output: z.object({ patch: z.string() }),
  },
  git_show: {
    input: z.object({ worktree: z.string(), sha: z.string(), path: z.string() }),
    output: z.object({ content: z.string().nullable(), binary: z.boolean() }),
  },
  gh_pr: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: ghPrSchema,
  },
  gh_threads: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: z.object({ threads: z.array(ghThreadSchema) }),
  },
  gh_conversation: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: z.object({ comments: z.array(ghIssueCommentSchema), reviews: z.array(ghReviewSchema) }),
  },
  gh_submit_review: {
    input: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
      commitId: z.string(),
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: z.string(),
      comments: z.array(
        z.object({
          path: z.string(),
          line: z.number(),
          side: z.enum(["LEFT", "RIGHT"]),
          startLine: z.number().nullable(),
          body: z.string(),
        }),
      ),
    }),
    output: z.object({ url: z.string().nullable(), id: z.number().nullable() }),
  },
  gh_reply: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number(), commentId: z.number(), body: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  gh_resolve: {
    input: z.object({ threadId: z.string(), resolve: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  codemap: {
    input: z.object({
      worktree: z.string(),
      baseSha: z.string(),
      headSha: z.string(),
      files: z.array(changedFileSchema),
      wasmDir: z.string().nullable(),
    }),
    output: codemapSchema,
  },
});
export type HostContract = typeof hostContract;
