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
  /** The repository the head branch lives in (a fork for cross-repository PRs). */
  headOwner: z.string().nullable(),
  headRepo: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullable(),
  updatedAt: z.string(),
  checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() })),
  labels: z.array(z.string()),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  commits: z.array(z.object({ sha: z.string(), title: z.string(), author: z.string(), date: z.string() })),
  createdAt: z.string(),
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

export const hostContract = defineRpcContract({
  /** Fetch the PR head and base, and keep a detached worktree at the head. `fetch: false` skips the network and only keeps the worktree in place. */
  repo_prepare: {
    input: z.object({
      repoPath: z.string(),
      number: z.number(),
      headSha: z.string(),
      baseRefName: z.string(),
      worktreesDir: z.string(),
      key: z.string(),
      fetch: z.boolean().optional(),
    }),
    output: z.object({ worktree: z.string(), headSha: z.string(), baseSha: z.string() }),
  },
  /** Remove a PR worktree the plugin created, unless it has local changes. */
  repo_remove_worktree: {
    input: z.object({ repoPath: z.string(), worktree: z.string() }),
    output: z.object({ removed: z.boolean(), reason: z.string().nullable() }),
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
  /** Message, author, date, and parents of one commit. */
  git_commit: {
    input: z.object({ worktree: z.string(), sha: z.string() }),
    output: z.object({ sha: z.string(), parents: z.array(z.string()), author: z.string(), date: z.string(), title: z.string(), body: z.string() }),
  },
  gh_pr: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: ghPrSchema,
  },
  /** The login gh is authenticated as: the account reviews are posted under. */
  gh_viewer: {
    input: z.object({}),
    output: z.object({ login: z.string() }),
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
  /**
   * The worktree with the PR's branch checked out, for the author's agent that
   * commits and pushes: an existing one, or a new one tracking the branch on the
   * remote that points at the PR's head repository.
   */
  branch_worktree: {
    input: z.object({ repoPath: z.string(), branch: z.string(), headOwner: z.string(), headRepo: z.string(), worktreesDir: z.string(), key: z.string() }),
    output: z.object({ worktree: z.string(), remote: z.string(), created: z.boolean() }),
  },
  /** A folder per repository that links each PR worktree as pr-<number>: the workspace Review Desk's visible threads share. */
  review_group_dir: {
    input: z.object({ worktree: z.string(), group: z.string(), number: z.number() }),
    output: z.object({ path: z.string() }),
  },
  /** Build diffmap's viewer once per pinned commit (clone, patch, npm ci, vite build); returns the built files. */
  diffmap_prepare: {
    input: z.object({}),
    output: z.object({ assets: z.array(z.string()) }),
  },
  /** One built viewer file, base64. */
  diffmap_asset: {
    input: z.object({ path: z.string() }),
    output: z.object({ base64: z.string() }),
  },
  /** The gist-shaped payload the viewer renders: the spec plus the diffs and files it references, read from the worktree. */
  diffmap_gist: {
    input: z.object({ worktree: z.string(), markdown: z.string(), label: z.string(), htmlUrl: z.string() }),
    output: z.object({ json: z.string() }),
  },
});
export type HostContract = typeof hostContract;
