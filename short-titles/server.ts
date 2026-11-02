// bb-plugin-short-titles: give new threads a 3-4 word title.
//
// On a new top-level thread's first turn, write a short title from its first
// prompt with `claude -p` and set it with bb.sdk.threads.update. bb's own
// title generator skips threads that already have a title, so this title wins
// whichever lands first. Unlike an AI-service title, this path has no 5 second
// deadline, so it can use Sonnet and retry once when the title runs long.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const MODEL = "sonnet";
const MAX_WORDS = 4;
// bb itself only generates titles for prompts of 5+ words; shorter prompts
// already make a short title.
const MIN_PROMPT_WORDS = 5;
// Only retitle threads whose first turn starts soon after creation, so a
// resumed old thread keeps its title.
const MAX_THREAD_AGE_MS = 10 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 30_000;
const MAX_PROMPT_CHARS = 4000;
const CLAUDE_ARGS = [
  "-p",
  "--model",
  MODEL,
  "--setting-sources=",
  "--strict-mcp-config",
  "--tools=",
  "--no-session-persistence",
  "--disable-slash-commands",
];

const titlePrompt = (task: string) => `Write a 3 or 4 word title for this coding task. Sentence case, no quotes, no trailing punctuation. Name the goal or problem, not the tools used. Reply with only the title.

Examples of good titles:
Fix flaky login test
Add dark mode toggle
Explain cache eviction metric
Speed up batch scheduler

Task:
${task}`;

const shortenPrompt = (title: string) =>
  `Shorten this title to at most ${MAX_WORDS} words. Keep the key subject, drop filler. Sentence case, no trailing punctuation. Reply with only the title.\n\n${title}`;

function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

function cleanTitle(reply: string): string {
  const line = reply.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/^title:\s*/iu, "")
    .replace(/^["'`*]+|["'`*]+$/gu, "")
    .replace(/[.!?:;,]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", CLAUDE_ARGS, {
      cwd: tmpdir(),
      signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

async function generateTitle(task: string): Promise<string | null> {
  const first = cleanTitle(await runClaude(titlePrompt(task)));
  if (!first || countWords(first) <= MAX_WORDS) return first || null;
  const second = cleanTitle(await runClaude(shortenPrompt(first)));
  return second && countWords(second) < countWords(first) ? second : first;
}

function firstPromptText(data: unknown): string {
  const input = (data as { input?: unknown } | null)?.input;
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((part) =>
      part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
        ? [part.text.trim()]
        : [],
    )
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export default async function plugin(bb: BbPluginApi) {
  const inFlight = new Set<string>();

  async function retitle(threadId: string): Promise<void> {
    const [event] = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "asc",
      limit: "1",
    });
    const task = firstPromptText(event?.data).slice(0, MAX_PROMPT_CHARS);
    if (countWords(task) < MIN_PROMPT_WORDS) return;
    const title = await generateTitle(task);
    if (!title) return;
    await bb.sdk.threads.update({ threadId, title });
    bb.log.info(`${threadId}: ${title}`);
  }

  bb.events.on("thread.active", async ({ thread }) => {
    if (thread.parentThreadId !== null || thread.originKind !== null) return;
    if (Date.now() - thread.createdAt > MAX_THREAD_AGE_MS) return;
    const doneKey = `done:${thread.id}`;
    if (inFlight.has(thread.id) || (await bb.storage.kv.get<boolean>(doneKey))) return;
    inFlight.add(thread.id);
    try {
      await bb.storage.kv.set(doneKey, true);
      await retitle(thread.id);
    } catch (error) {
      bb.log.warn(`${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(thread.id);
    }
  });
}
