// Host side of the factory's skills: the author's skills on this machine, and
// the repository's skills and AGENTS.md files exported from its latest default
// branch (not the PR branch) into a per-commit cache the agents read.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
    return { stdout, ok: true };
  } catch (cause) {
    return { stdout: (cause as { stdout?: string }).stdout ?? "", ok: false };
  }
}

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);

/** name and description from a SKILL.md's front matter; a folded description (>-) is joined. */
function skillMeta(file: string, fallback: string): { name: string; description: string } {
  const text = readFileSync(file, "utf8");
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const lines = front.split("\n");
  const field = (key: string): string => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at === -1) return "";
    const first = lines[at]!.slice(key.length + 1).trim();
    if (first !== "" && !/^[>|][-+]?$/.test(first)) return first.replace(/^['"]|['"]$/g, "");
    const rest: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(l)) break;
      rest.push(l.trim());
    }
    return rest.join(" ");
  };
  return { name: field("name") || fallback, description: field("description") };
}

/** Where an agent's own skills live on this machine; the first folder that has the skill wins. */
function personalRoots(): string[] {
  const env = process.env;
  return [
    path.join(env.CLAUDE_HOME ?? path.join(homedir(), ".claude"), "skills"),
    path.join(env.CODEX_HOME ?? path.join(homedir(), ".codex"), "skills"),
    path.join(homedir(), ".agents", "skills"),
  ];
}

export interface FactorySkillsInput { repoPath: string; remote: string | null; owner: string; repo: string; personal: string[]; changedPaths: string[]; sha?: string | null }
export interface FactorySkillsOutput {
  ref: string | null;
  sha: string | null;
  root: string | null;
  personal: { name: string; path: string; digest: string }[];
  repo: { name: string; path: string; description: string; digest: string }[];
  agents: { dir: string; path: string; performance: boolean; digest: string }[];
  perfDirs: string[];
}

export async function factorySkills(input: FactorySkillsInput): Promise<FactorySkillsOutput> {
  const personal: FactorySkillsOutput["personal"] = [];
  for (const name of input.personal) {
    const file = personalRoots().map((root) => path.join(root, name, "SKILL.md")).find((f) => existsSync(f));
    if (file !== undefined) personal.push({ name, path: file, digest: digest(file) });
  }
  const none: FactorySkillsOutput = { ref: null, sha: null, root: null, personal, repo: [], agents: [], perfDirs: [] };
  const remote = input.remote ?? "origin";
  let branch: string | null = null;
  let sha = "";
  if (input.sha) {
    // A frozen commit (a replay): the skills as they were then, with nothing fetched.
    sha = (await git(input.repoPath, ["rev-parse", "--verify", "--quiet", `${input.sha}^{commit}`])).stdout.trim();
    if (sha === "") return none;
    branch = `commit ${sha.slice(0, 10)}`;
  } else {
    // The default branch, as the remote names it; main, then master, when the checkout never recorded it.
    const head = (await git(input.repoPath, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`])).stdout.trim().replace(`${remote}/`, "");
    for (const candidate of [head, "main", "master"].filter((b) => b !== "")) {
      // Latest means fetched now; a failed fetch (offline) falls back to what the checkout already has.
      await git(input.repoPath, ["fetch", "--quiet", remote, `+refs/heads/${candidate}:refs/remotes/${remote}/${candidate}`]);
      if ((await git(input.repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`])).ok) {
        branch = candidate;
        break;
      }
    }
    if (branch === null) return none;
    sha = (await git(input.repoPath, ["rev-parse", `refs/remotes/${remote}/${branch}`])).stdout.trim();
    if (sha === "") return none;
  }

  const base = path.join(homedir(), ".review-desk", "skills", `${input.owner}__${input.repo}`);
  const root = path.join(base, sha.slice(0, 12));
  const tree = (await git(input.repoPath, ["ls-tree", "-r", "--name-only", sha])).stdout.split("\n").filter((l) => l !== "");
  const agentsFiles = tree.filter((f) => f === "AGENTS.md" || f.endsWith("/AGENTS.md"));
  const skillsDir = [".agents/skills", ".claude/skills"].find((d) => tree.some((f) => f.startsWith(`${d}/`)));
  if (!existsSync(path.join(root, ".ready"))) {
    // Two jobs may want the same new commit at once: each extracts into its own folder, and the first to finish becomes the export.
    mkdirSync(base, { recursive: true });
    const scratch = `${root}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(scratch, { recursive: true });
    const paths = [...(skillsDir === undefined ? [] : [skillsDir]), ...agentsFiles];
    if (paths.length > 0) {
      await execFileAsync("bash", ["-c", 'set -o pipefail; git -C "$1" archive "$2" -- "${@:4}" | tar -x -C "$3"', "bash", input.repoPath, sha, scratch, ...paths], { maxBuffer: 64 * 1024 * 1024 });
    }
    writeFileSync(path.join(scratch, ".ready"), `${remote}/${branch} ${sha}\n`);
    if (existsSync(path.join(root, ".ready"))) rmSync(scratch, { recursive: true, force: true });
    else {
      rmSync(root, { recursive: true, force: true });
      try {
        renameSync(scratch, root);
      } catch {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    // Keep the three newest exports and anything from the last two days (a long job may still be reading it); clear scratch folders a crash left.
    const now = Date.now();
    const dirs = readdirSync(base).map((d) => path.join(base, d)).filter((d) => d !== root && statSync(d).isDirectory());
    const exportsByAge = dirs.filter((d) => !d.includes(".tmp-")).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const dir of exportsByAge.slice(2)) if (now - statSync(dir).mtimeMs > 2 * 24 * 3_600_000) rmSync(dir, { recursive: true, force: true });
    for (const dir of dirs.filter((d) => d.includes(".tmp-"))) if (now - statSync(dir).mtimeMs > 3_600_000) rmSync(dir, { recursive: true, force: true });
  }

  const repo: FactorySkillsOutput["repo"] = [];
  if (skillsDir !== undefined && existsSync(path.join(root, skillsDir))) {
    for (const entry of readdirSync(path.join(root, skillsDir), { withFileTypes: true })) {
      const file = path.join(root, skillsDir, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      repo.push({ ...skillMeta(file, entry.name), name: entry.name, path: file, digest: digest(file) });
    }
    repo.sort((a, b) => a.name.localeCompare(b.name));
  }
  const withPerf = new Set(agentsFiles.filter((f) => /\n## Performance\b/.test(readFileSync(path.join(root, f), "utf8"))));
  const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
  // Every AGENTS.md above a changed file: the crate's, a sub-module's, and the root's.
  const wanted = new Set<string>();
  for (const changed of input.changedPaths) {
    let dir = dirOf(changed);
    for (;;) {
      const file = dir === "" ? "AGENTS.md" : `${dir}/AGENTS.md`;
      if (agentsFiles.includes(file)) wanted.add(file);
      if (dir === "") break;
      dir = dirOf(dir);
    }
  }
  const agents = [...wanted].sort((a, b) => b.length - a.length).slice(0, 40).map((f) => ({ dir: dirOf(f), path: path.join(root, f), performance: withPerf.has(f), digest: digest(path.join(root, f)) }));
  return { ref: input.sha ? branch : `${remote}/${branch}`, sha, root, personal, repo, agents, perfDirs: [...withPerf].map(dirOf).filter((d) => d !== "") };
}
