// The PR factory's prompts and skills map, read from files: prompts/*.md (one
// file per stage, process only) and factory-skills.json (which skills each
// stage must read, per repository). Server only: app.tsx never imports this.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_LABELS, AI_LABEL_MEANING, AI_REVIEW_FENCE, FIX_FENCE, type PriorFinding } from "./factory-spec";

export type SkillStage = "review" | "perf" | "fix" | "check" | "babysit";

export interface RepoSkills {
  review: string[];
  perf: string[];
  /** Skills that run a benchmark; named in the perf prompt's measure step. */
  measure: string[];
  fix: string[];
  check: string[];
  /** Skills for the CI babysitter: how this repository's CI is started, read, and re-run. */
  babysit: string[];
  /**
   * How CI is babysat here. guide: a file in the plugin with this repository's CI rules, shown in the babysit prompt.
   * act: whose PRs the factory may push to for CI (merge the base in, small fixes): "mine" (your own) or "any" (every PR on the board).
   */
  ci: { guide: string; act: "mine" | "any" };
  /** The repository has topic skills, not one review skill: the reviewer reads each whose description fits the diff. */
  reviewByTopic: boolean;
  /** Path prefixes on a request path; a diff that touches one gets a perf review. Directories whose AGENTS.md has a Performance section count too. */
  perfPaths: string[];
  /** The repository whose latest default branch the skills are read from (a fork reads its upstream's). */
  source: string;
}

export interface SkillsConfig {
  personal: Record<SkillStage, string[]>;
  repos: Record<string, Partial<RepoSkills> & { sameAs?: string }>;
}

export interface FactoryFiles {
  dir: string;
  /** "review" is the text before the first section marker of review.md; "review@scope-delta" is a named section. */
  parts: Map<string, string>;
  /** A prompt's version: a hash of its file's text. */
  versions: Record<string, string>;
  skills: SkillsConfig;
}

/** The plugin's folder at run time: beside this file from source, one up from dist/ when bundled. */
function factoryDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, join(here, ".."), process.cwd()]) {
    if (existsSync(join(dir, "prompts", "review.md"))) return dir;
  }
  throw new Error(`prompts/review.md not found near ${here}`);
}

const SECTION = /^<!-- @([\w-]+) -->\s*$/;

export function loadFactoryFiles(dir = factoryDir()): FactoryFiles {
  const parts = new Map<string, string>();
  const versions: Record<string, string> = {};
  for (const file of readdirSync(join(dir, "prompts")).filter((f) => f.endsWith(".md")).sort()) {
    const name = file.replace(/\.md$/, "");
    const text = readFileSync(join(dir, "prompts", file), "utf8");
    versions[name] = createHash("sha256").update(text).digest("hex").slice(0, 16);
    let key = name;
    let lines: string[] = [];
    const flush = () => parts.set(key, lines.join("\n").trim());
    for (const line of text.split("\n")) {
      const marker = SECTION.exec(line);
      if (marker === null) {
        lines.push(line);
        continue;
      }
      flush();
      key = `${name}@${marker[1]}`;
      lines = [];
    }
    flush();
  }
  const skills = JSON.parse(readFileSync(join(dir, "factory-skills.json"), "utf8")) as SkillsConfig;
  return { dir, parts, versions, skills };
}

/** Fill {{name}} slots. An unknown slot or a missing part is a bug in the prompt file, so it throws. */
export function render(files: FactoryFiles, part: string, vars: Record<string, string | number>): string {
  const text = files.parts.get(part);
  if (text === undefined) throw new Error(`prompt part ${part} does not exist`);
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`prompt part ${part} uses {{${name}}}, which was not given`);
    return String(vars[name]);
  });
}

const EMPTY: RepoSkills = { review: [], perf: [], measure: [], fix: [], check: [], babysit: [], ci: { guide: "", act: "mine" }, reviewByTopic: true, perfPaths: [], source: "" };

/** The skills map for a repository; one it does not list gets topic picking from its own skills and no perf paths. */
export function repoSkills(config: SkillsConfig, owner: string, repo: string): RepoSkills {
  const key = Object.keys(config.repos).find((k) => k.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  const entry = key === undefined ? undefined : config.repos[key];
  if (entry === undefined) return { ...EMPTY, source: `${owner}/${repo}` };
  if (entry.sameAs !== undefined) {
    const [o, r] = entry.sameAs.split("/");
    return { ...repoSkills(config, o ?? owner, r ?? repo), ...Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "sameAs")) };
  }
  return { ...EMPTY, ...entry, source: entry.source ?? key ?? `${owner}/${repo}` };
}

/** One file a job is told to read, and where it came from. */
export interface SkillFile { name: string; path: string; digest: string; source: "personal" | "repo" | "agents" | "topic" | "extra"; description?: string }

/** What the host found: the author's skills on the machine, and the repository's skills and AGENTS.md at its latest default branch. */
export interface ResolvedSkills {
  ref: string | null;
  sha: string | null;
  root: string | null;
  personal: { name: string; path: string; digest: string }[];
  repo: { name: string; path: string; description: string; digest: string }[];
  agents: { dir: string; path: string; performance: boolean; digest: string }[];
  perfDirs: string[];
}

/** The files a stage must read, picked from what the host found by the skills map. */
export function skillFiles(config: SkillsConfig, map: RepoSkills, stage: SkillStage, found: ResolvedSkills, extra: string[]): SkillFile[] {
  const out: SkillFile[] = [];
  for (const name of config.personal[stage] ?? []) {
    const hit = found.personal.find((s) => s.name === name);
    if (hit !== undefined) out.push({ ...hit, source: "personal" });
  }
  const named = stage === "perf" ? [...map.perf, ...map.measure] : map[stage];
  for (const name of named) {
    const hit = found.repo.find((s) => s.name === name);
    if (hit !== undefined) out.push({ name: hit.name, path: hit.path, digest: hit.digest, source: "repo" });
  }
  if (stage === "review" || stage === "perf") {
    for (const a of found.agents) {
      if (stage === "perf" && !a.performance) continue;
      out.push({ name: `${a.dir === "" ? "" : `${a.dir}/`}AGENTS.md`, path: a.path, digest: a.digest, source: "agents" });
    }
  }
  if (stage === "review" && map.reviewByTopic) {
    for (const s of found.repo) {
      if (!out.some((o) => o.path === s.path)) out.push({ name: s.name, path: s.path, digest: s.digest, source: "topic", description: s.description });
    }
  }
  for (const name of extra) {
    const hit = found.repo.find((s) => s.name === name) ?? found.personal.find((s) => s.name === name);
    if (hit !== undefined && !out.some((o) => o.path === hit.path)) out.push({ name: hit.name, path: hit.path, digest: hit.digest, source: "extra" });
  }
  return out;
}

/** The "Read first" list as the prompt shows it. */
export function skillsBlock(files: SkillFile[], found: ResolvedSkills, map: RepoSkills): string {
  const of = (source: SkillFile["source"]) => files.filter((f) => f.source === source);
  const lines: string[] = [];
  const list = (title: string, items: SkillFile[], withDescription = false) => {
    if (items.length === 0) return;
    lines.push(title, ...items.map((f) => `- ${f.name}: ${f.path}${withDescription && f.description ? `\n    ${f.description.slice(0, 240)}` : ""}`), "");
  };
  const at = found.sha === null ? "" : ` (${map.source} ${found.ref ?? "default branch"} at ${found.sha.slice(0, 10)})`;
  list("The author's skills, from this machine:", [...of("personal"), ...of("extra")]);
  list(`The repository's skills${at}:`, of("repo"));
  list(`AGENTS.md for the directories this diff touches${at}:`, of("agents"));
  list(`The repository's topic skills${at}. Read each one whose description fits what the diff touches, and skip the rest:`, of("topic"), true);
  if (lines.length === 0) return "(no skill files were found for this stage; review from the code alone)";
  lines.push("A SKILL.md may point to reference files in its own folder; read the ones it tells you to.");
  return lines.join("\n");
}

/** A diff gets a perf review when it touches a listed request path or a directory whose AGENTS.md has a Performance section. */
export function perfReason(map: RepoSkills, found: ResolvedSkills, changedPaths: string[]): string | null {
  const prefixes = [...map.perfPaths, ...found.perfDirs.map((d) => (d === "" ? "" : `${d}/`)).filter((d) => d !== "")];
  const hits = new Map<string, number>();
  for (const p of changedPaths) {
    const prefix = prefixes.filter((x) => p.startsWith(x)).sort((a, b) => b.length - a.length)[0];
    if (prefix !== undefined) hits.set(prefix, (hits.get(prefix) ?? 0) + 1);
  }
  if (hits.size === 0) return null;
  return [...hits.entries()].slice(0, 8).map(([prefix, n]) => `${n} file${n === 1 ? "" : "s"} under ${prefix}`).join(", ");
}

// -- prompts -------------------------------------------------------------------

const REVIEW_OUTPUT = [
  `Reply with one fenced block tagged ${AI_REVIEW_FENCE}:`,
  "{",
  '  "summary": string,            // 2-4 sentences for the PR author: what the change does and the overall verdict',
  '  "read": string[],             // the names of the skill and AGENTS.md files you read',
  `  "findings": [{ "path": string, "line": number, "endLine"?: number, "label": ${AI_LABELS.map((l) => `"${l}"`).join("|")}, "title": string, "body": string, "suggestion"?: string }],`,
  '  "previous": [{ "id": string, "status": "fixed"|"open"|"obsolete", "note": string }]   // one entry per earlier finding listed in this round; empty when none are listed',
  "}",
  "label: the one bucket that fits best. Map whatever scale your skills use onto these:",
  ...AI_LABELS.map((l) => `  ${l}: ${AI_LABEL_MEANING[l]}`),
  "path and line: a changed file and a line number at the head sha, on a line the diff adds or shows as context. endLine for a range. A finding in code the diff does not show still gets its real path and line; it is posted in the review's body.",
  "title: at most 12 words. body: GitHub Markdown written to the PR author: what is wrong, when it triggers, what it costs, and the fix. suggestion: replacement code for exactly those lines, only when the fix is obvious.",
].join("\n");

const FIX_OUTPUT = [
  `Reply with one fenced block tagged ${FIX_FENCE}:`,
  "{",
  '  "summary": string,   // 2-4 sentences for the author: what you changed and what you left',
  '  "items": [{ "url": string, "author": string, "verdict": "FIX"|"SKIP"|"ASK", "reason": string, "commit"?: string }],   // one per comment or thread you judged; url is its GitHub URL',
  '  "pushed": boolean,',
  '  "head": string        // git rev-parse HEAD in the worktree',
  "}",
].join("\n");

export interface ReviewContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
  round: number;
  /** full: the whole PR (round 1, and the fresh pass before ready). delta: what changed since the previous round. */
  kind: "full" | "delta";
  prev: { baseSha: string; headSha: string } | null;
  prior: PriorFinding[];
  threads: string[];
  changedPaths: string[];
  skills: string;
  empirical: boolean;
}

const priorLines = (prior: PriorFinding[]) =>
  prior.length === 0 ? "  (none)" : prior.map((f) => `  [${f.id}] round ${f.round}, ${f.severity}, ${f.path}:${f.line}: ${f.title}\n      ${f.body.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");

export function reviewPrompt(files: FactoryFiles, c: ReviewContext): string {
  const header = [
    `AI review of ${c.owner}/${c.repo}#${c.number} "${c.title}"${c.author ? ` by ${c.author}` : ""}.`,
    `Merge base with ${c.baseRef}: ${c.baseSha}. Head: ${c.headSha}.`,
    `Changed files (${c.changedPaths.length}): ${c.changedPaths.slice(0, 120).join(", ")}${c.changedPaths.length > 120 ? ", ..." : ""}`,
    `PR description and conversation: gh pr view ${c.number} --repo ${c.owner}/${c.repo} --comments`,
    ...(c.threads.length === 0 ? [] : ["", "Unresolved GitHub review threads (do not repeat what they already say):", ...c.threads.map((t) => `  ${t}`)]),
  ].join("\n");
  const vars = { round: c.round, baseSha: c.baseSha, headSha: c.headSha, baseRef: c.baseRef, prevBase: c.prev?.baseSha ?? "", prevHead: c.prev?.headSha ?? "", prior: priorLines(c.prior) };
  const scope = render(files, c.prev === null ? "review@scope-first" : c.kind === "delta" ? "review@scope-delta" : "review@scope-full", vars);
  return render(files, "review", {
    header,
    skills: c.skills,
    scope,
    empirical: render(files, c.empirical ? "review@empirical-on" : "review@empirical-off", {}),
    output: REVIEW_OUTPUT,
  });
}

export function perfPrompt(files: FactoryFiles, c: { owner: string; repo: string; number: number; baseSha: string; headSha: string; why: string; skills: string; measure: string[] }): string {
  return render(files, "perf", {
    pr: `${c.owner}/${c.repo}#${c.number}`,
    baseSha: c.baseSha,
    headSha: c.headSha,
    why: c.why,
    skills: c.skills,
    measure: c.measure.length === 0 ? "none is listed for this repository; use the benchmark the AGENTS.md names" : c.measure.join(", "),
    output: REVIEW_OUTPUT,
  });
}

interface FixContext { owner: string; repo: string; number: number; baseSha: string; headSha: string; skills: string }

export function fixPrompt(files: FactoryFiles, c: FixContext & { source: string; reviewUrl: string | null }): string {
  return render(files, "fix", { pr: `${c.owner}/${c.repo}#${c.number}`, source: c.source, reviewUrl: c.reviewUrl ? ` (${c.reviewUrl})` : "", baseSha: c.baseSha, headSha: c.headSha, skills: c.skills, output: FIX_OUTPUT });
}

export function deslopPrompt(files: FactoryFiles, c: FixContext): string {
  return render(files, "fix@deslop", { pr: `${c.owner}/${c.repo}#${c.number}`, baseSha: c.baseSha, headSha: c.headSha });
}

export function ciFixPrompt(files: FactoryFiles, c: FixContext & { diagnosis: string; failing: { name: string; url: string | null }[] }): string {
  return render(files, "fix@ci", {
    pr: `${c.owner}/${c.repo}#${c.number}`,
    baseSha: c.baseSha,
    headSha: c.headSha,
    diagnosis: c.diagnosis,
    failing: c.failing.map((f) => `  ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n") || "  (none listed)",
    output: FIX_OUTPUT,
  });
}

export interface CheckItem { url: string; author: string; verdict: string; reason: string; commit?: string | null }

export function checkPrompt(files: FactoryFiles, c: { owner: string; repo: string; number: number; baseSha: string; headBefore: string; head: string; items: CheckItem[]; skills: string }): string {
  const items = c.items.filter((i) => (i.commit ?? "") !== "");
  return render(files, "check", {
    pr: `${c.owner}/${c.repo}#${c.number}`,
    baseSha: c.baseSha,
    headBefore: c.headBefore,
    head: c.head,
    skills: c.skills,
    items: items.length === 0
      ? "(the agent listed no commit per comment; read the commit messages)"
      : items.map((i) => `- ${(i.commit ?? "").slice(0, 12)} answers ${i.url || `@${i.author}`}: ${i.reason.replace(/\s+/g, " ").slice(0, 300)}`).join("\n"),
  });
}

export function revisePrompt(files: FactoryFiles, c: { rejections: { commit: string; reason: string }[] }): string {
  return render(files, "fix@revise", {
    count: c.rejections.length,
    rejections: c.rejections.map((r) => `- ${r.commit.slice(0, 12)}: ${r.reason.replace(/\s+/g, " ")}`).join("\n"),
    output: FIX_OUTPUT,
  });
}

export function publishPrompt(files: FactoryFiles, c: { checkLine: string; push: string }): string {
  return render(files, "fix@publish", { checkLine: c.checkLine, push: c.push, output: FIX_OUTPUT });
}

export function learnPrompt(files: FactoryFiles, c: { pr: string; humans: unknown; findings: unknown; fixItems: unknown; rounds: unknown }): string {
  const json = (v: unknown) => JSON.stringify(v, null, 1).slice(0, 120_000);
  return render(files, "learn", { pr: c.pr, humans: json(c.humans), findings: json(c.findings), fixItems: json(c.fixItems), rounds: json(c.rounds) });
}

export interface BabysitContext {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  pass: number;
  maxPasses: number;
  failing: { name: string; url: string | null }[];
  conflicting: boolean;
  /** The factory may push to this PR for CI: merge the base in, and fix what the PR's own code breaks. */
  canAct: boolean;
  /** It is your own PR, so a fix of any size goes to the author's agent. */
  mine: boolean;
  skills: string;
  /** The repository's CI guide file, relative to the plugin's folder; empty when it has none. */
  guide: string;
}

export function babysitPrompt(files: FactoryFiles, c: BabysitContext): string {
  const header = [
    `Pass ${c.pass} of at most ${c.maxPasses} at head ${c.headSha} of ${c.owner}/${c.repo}#${c.number}.`,
    c.conflicting ? "GitHub reports merge conflicts with the base branch." : "",
    c.failing.length === 0 ? "No failing checks are reported." : `Failing checks:\n${c.failing.map((f) => `  ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n")}`,
  ].filter((l) => l !== "").join("\n");
  let guide = "(this repository has no CI guide; go by its skills and its contribution guide)";
  if (c.guide !== "") {
    const path = join(files.dir, c.guide);
    if (existsSync(path)) guide = readFileSync(path, "utf8").trim();
  }
  const actions = c.canAct
    ? [
        `- \`merge_base\`: the branch conflicts with ${c.baseRef}, or a fix has landed on ${c.baseRef} since the merge base (check git log <merge-base>..origin/${c.baseRef}), or a test fails only against an old base. The base is merged into the branch and pushed for you; do not merge yourself. A conflict is never a reason for needs_human.`,
        c.mine
          ? "- `fix`: the PR's own code causes the failure (a test it breaks, a type, build, or lint error in what it changed). The author's agent fixes it on the branch; its commit is checked before it is pushed. In detail name the check, the failing test or error, and the cause you found, with file:line; list the failing job URLs in `jobs`."
          : "- `fix`: the PR's own code causes the failure, and the fix is small and clean (the repository's guide above says how small). An agent fixes it on the PR's branch for the maintainer; its commit is checked before it is pushed. In detail name the check, the failing test or error, and the cause you found, with file:line; list the failing job URLs in `jobs`.",
      ].join("\n")
    : "- A failure the PR's own code causes, or one that needs the base merged in: needs_human; this PR is not one the factory pushes to.";
  const outcomes = ['"rerun"', '"waiting"', ...(c.canAct ? ['"merge_base"', '"fix"'] : []), '"blocked"', '"ok"', '"needs_human"'].join(" | ");
  return render(files, "babysit", { header, skills: c.skills, guide, actions, outcomes });
}
