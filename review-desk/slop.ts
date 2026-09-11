// Deterministic "AI slop" signals over a PR diff. No model involved: every
// signal is a regex or a count over added and removed lines, and every hit
// carries the line it came from so the UI can jump to it. The score is a
// heuristic and is presented as one.
import type { ChangedFile } from "./host-contract";

export interface Evidence {
  path: string;
  /** Head line for additions, base line for removals, null for PR-body hits. */
  line: number | null;
  side: "old" | "new";
  note: string;
}

export interface SlopSignal {
  id: string;
  label: string;
  /** One sentence on why this counts. */
  description: string;
  count: number;
  /** Weighted contribution after the per-signal cap. */
  score: number;
  evidence: Evidence[];
}

export interface SlopReport {
  /** 0-100. */
  score: number;
  verdict: string;
  signals: SlopSignal[];
  stats: { files: number; codeFiles: number; addedLines: number; removedLines: number; addedCode: number; addedComments: number; bodyWords: number };
  /** The PR body names an AI author or tool. Informational, not scored. */
  aiAttributed: boolean;
}

interface PatchLine {
  line: number;
  text: string;
}
export interface ParsedPatch {
  added: PatchLine[];
  removed: PatchLine[];
}

/** Unified diff of one file to added (head numbers) and removed (base numbers) lines. */
export function parsePatch(patch: string): ParsedPatch {
  const added: PatchLine[] = [];
  const removed: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      added.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      removed.push({ line: oldLine, text: raw.slice(1) });
      oldLine++;
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      oldLine++;
      newLine++;
    }
  }
  return { added, removed };
}

const CODE_EXT = new Set(["rs", "py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "c", "cc", "cpp", "cxx", "h", "hpp", "java", "kt", "kts", "swift", "rb", "cs", "sh", "bash", "zsh", "scala", "php", "lua", "zig"]);
const HASH_COMMENT_EXT = new Set(["py", "rb", "sh", "bash", "zsh", "yaml", "yml", "toml"]);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|(_test|\.test|\.spec|_spec)\.[a-z]+$|^test_/i;

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i + 1).toLowerCase();
}

export function isCodeFile(path: string): boolean {
  return CODE_EXT.has(ext(path));
}

/** The comment text of a line, or null when the line is code. */
export function commentText(path: string, text: string): string | null {
  const t = text.trim();
  if (t === "") return null;
  const e = ext(path);
  if (HASH_COMMENT_EXT.has(e)) {
    if (t.startsWith("#!") || t.startsWith("#[")) return null;
    if (t.startsWith("#")) return t.replace(/^#+\s?/, "");
    if (/^("""|''')/.test(t)) return t.replace(/^("""|''')/, "").replace(/("""|''')$/, "");
    return null;
  }
  if (e === "rs" && t.startsWith("#[")) return null;
  if (t.startsWith("//")) return t.replace(/^\/\/[/!]?\s?/, "");
  // A block-comment continuation is "* text"; "*existing = x" is a deref.
  if (t.startsWith("/*") || t === "*" || t === "*/" || /^\*\s/.test(t) || /^\*\/\s/.test(t)) return t.replace(/^\/?\*+\/?\s?/, "");
  if (e === "lua" || e === "sql") return t.startsWith("--") ? t.replace(/^--\s?/, "") : null;
  return null;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "is", "are", "be", "this", "that", "with", "from", "by", "as", "at", "it", "its", "we", "if", "then", "else", "when", "into", "our", "new", "set", "get"]);

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9_]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

function identifierTokens(code: string): Set<string> {
  const out = new Set<string>();
  for (const ident of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    out.add(ident.toLowerCase());
    for (const part of ident.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\s]+/)) if (part.length >= 3) out.add(part.toLowerCase());
  }
  return out;
}

const AI_PHRASES = /\b(this ensures|ensures? that|to ensure|robust(?:ly|ness)?|comprehensive(?:ly)?|seamless(?:ly)?|leverag(?:e|es|ing)|it'?s (?:important|worth) (?:to note|noting)|note that|in order to|handles? (?:all )?edge cases|gracefully|for clarity|properly|correctly handl\w+|elegant(?:ly)?|streamlin\w+|enhanc(?:e|es|ed|ing)|crucial|as expected|best practices?|delve|utiliz\w+|a wide range of|plays a (?:key|crucial|vital) role|it is worth|serves as|encapsulat\w+ the logic)\b/i;
const TEMPLATE_HEADERS = /^\s*(?:#{1,3}\s*)?(?:[\p{Extended_Pictographic}]\s*)?(summary|key changes|changes made|test plan|testing|what changed|why|motivation|checklist|implementation details|breaking changes)\b/imu;
const AI_ATTRIBUTION = /(🤖|generated with|co-authored-by:\s*(?:claude|codex|copilot|cursor|devin|gemini|chatgpt|openai|anthropic)|\b(?:claude|codex|copilot|cursor|devin|gemini|chatgpt)\b[^\n]{0,40}\b(?:generated|written|authored|assisted))/i;
const STUB = /\b(TODO|FIXME|XXX|HACK)\b|\bplaceholder\b|\bfor now\b|\bnot implemented\b|unimplemented!\(|todo!\(|NotImplementedError|raise NotImplemented\b/i;
const SKIP_TEST = /#\[ignore\]|@pytest\.mark\.skip|@unittest\.skip|\b(?:it|test|describe)\.skip\(|\bx(?:it|describe|test)\(|\.skip\(\)|t\.Skip\(/;
const WEAK_ASSERT = /\bassert\s+True\b|assert\s+\w+\s+is\s+not\s+None\s*$|assert!\(true\)|expect\(\w+\)\.toBeDefined\(\)\s*;?\s*$|assert\s+\w+\s*$/;
const ASSERT = /\bassert(?:_eq|_ne|!|\(|\s)|\bexpect\(|\.should\b|\brequire\.|\bassert\./;
const DEFENSIVE: { re: RegExp; note: string; weight: number }[] = [
  { re: /except\s*(?:Exception|BaseException)?\s*:\s*$/, note: "broad except", weight: 2 },
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/, note: "empty catch", weight: 2 },
  { re: /\.unwrap_or_default\(\)/, note: "unwrap_or_default hides a missing value", weight: 0.5 },
  { re: /#\s*type:\s*ignore|@ts-ignore|@ts-expect-error|\bas any\b/, note: "type check silenced", weight: 2 },
  { re: /if\s+\w+\s+is\s+not\s+None\s+and\s+\w+\s+is\s+not\s+None/, note: "chained None guards", weight: 1 },
  { re: /\?\?\s*\{\}\s*\)?\s*;?\s*$|\|\|\s*\{\}\s*;?\s*$/, note: "fallback to an empty object", weight: 1 },
];
/** A comment line that is really code: statement-shaped, few words, no sentence punctuation. */
function looksLikeCode(c: string): boolean {
  const t = c.trim();
  if (/[.!?:]\s*$/.test(t) && !/[;{}]\s*$/.test(t)) return false;
  const statement = /[;{}]\s*$/.test(t) || /^(let|const|var|if|for|while|return|fn|def|import|use|match|self\.|this\.|\w+\s*=\s*\w|\w+\(.*\)\s*;?$)/.test(t);
  return statement && words(t).length <= 6;
}

export interface SlopInput {
  files: ChangedFile[];
  patches: Map<string, string>;
  title: string;
  body: string;
  /** path -> module from the codemap, when built. */
  moduleOf: Map<string, string> | null;
}

export function computeSlop(input: SlopInput): SlopReport {
  const parsed = new Map<string, ParsedPatch>();
  for (const [path, patch] of input.patches) parsed.set(path, parsePatch(patch));
  const codePaths = input.files.filter((f) => isCodeFile(f.path) && !f.binary).map((f) => f.path);
  const nonTestCode = codePaths.filter((p) => !TEST_PATH.test(p));
  const stats = { files: input.files.length, codeFiles: codePaths.length, addedLines: 0, removedLines: 0, addedCode: 0, addedComments: 0, bodyWords: input.body.trim() === "" ? 0 : input.body.trim().split(/\s+/).length };
  for (const [path, p] of parsed) {
    stats.addedLines += p.added.length;
    stats.removedLines += p.removed.length;
    if (!isCodeFile(path)) continue;
    for (const l of p.added) {
      if (commentText(path, l.text) !== null) stats.addedComments++;
      else if (l.text.trim() !== "") stats.addedCode++;
    }
  }

  const signals: SlopSignal[] = [];
  const push = (id: string, label: string, description: string, weight: number, cap: number, evidence: Evidence[], rawScore?: number) => {
    if (evidence.length === 0) return;
    signals.push({ id, label, description, count: evidence.length, score: Math.min(cap, rawScore ?? weight * evidence.length), evidence: evidence.slice(0, 40) });
  };

  // 1. AI phrasing in added comments and in the description.
  {
    const ev: Evidence[] = [];
    for (const path of codePaths) {
      for (const l of parsed.get(path)?.added ?? []) {
        const c = commentText(path, l.text);
        if (c === null) continue;
        const m = AI_PHRASES.exec(c);
        if (m !== null) ev.push({ path, line: l.line, side: "new", note: `"${m[0]}"` });
      }
    }
    for (const sentence of input.body.split(/(?<=[.!?])\s+|\n/)) {
      const m = AI_PHRASES.exec(sentence);
      if (m !== null) ev.push({ path: "", line: null, side: "new", note: `description: "${m[0]}"` });
    }
    push("ai-phrasing", "AI phrasing", "Filler that models add and people cut: ensures, robust, seamlessly, leverage, note that.", 1.5, 20, ev);
  }

  // 2. Comments that restate the next line of code.
  {
    const ev: Evidence[] = [];
    for (const path of codePaths) {
      const added = parsed.get(path)?.added ?? [];
      const byLine = new Map(added.map((l) => [l.line, l.text]));
      for (const l of added) {
        const c = commentText(path, l.text);
        if (c === null) continue;
        const ws = words(c);
        if (ws.length < 3 || ws.length > 14) continue;
        const next = byLine.get(l.line + 1) ?? byLine.get(l.line + 2);
        if (next === undefined || commentText(path, next) !== null) continue;
        const idents = identifierTokens(next);
        const covered = ws.filter((w) => idents.has(w) || [...idents].some((t) => t.length >= 4 && (w.startsWith(t) || t.startsWith(w)))).length;
        if (covered / ws.length >= 0.6) ev.push({ path, line: l.line, side: "new", note: c.slice(0, 80) });
      }
    }
    push("restating-comments", "Comments that repeat the code", "The comment says what the next line already says. Reads like narration for a model, not for a reader.", 2, 16, ev);
  }

  // 3. Defensive noise.
  {
    const ev: Evidence[] = [];
    let weighted = 0;
    let unwraps = 0;
    for (const path of nonTestCode) {
      for (const l of parsed.get(path)?.added ?? []) {
        for (const d of DEFENSIVE) {
          if (!d.re.test(l.text)) continue;
          ev.push({ path, line: l.line, side: "new", note: d.note });
          weighted += d.weight;
        }
        if (ext(path) === "rs" && /\.unwrap\(\)/.test(l.text)) unwraps++;
      }
    }
    if (unwraps > 8) {
      ev.push({ path: nonTestCode.find((p) => ext(p) === "rs") ?? "", line: null, side: "new", note: `${unwraps} new .unwrap() calls outside tests` });
      weighted += 2;
    }
    push("defensive-noise", "Defensive noise", "Broad catches, silenced type checks, chained None guards, and fallbacks that hide failures instead of handling them.", 2, 14, ev, weighted);
  }

  // 4. Tests weakened or skipped.
  {
    const ev: Evidence[] = [];
    for (const path of codePaths) {
      const p = parsed.get(path);
      if (p === undefined) continue;
      for (const l of p.added) {
        if (SKIP_TEST.test(l.text)) ev.push({ path, line: l.line, side: "new", note: "test skipped or ignored" });
        else if (TEST_PATH.test(path) && WEAK_ASSERT.test(l.text)) ev.push({ path, line: l.line, side: "new", note: "assertion that cannot fail" });
      }
      if (TEST_PATH.test(path)) {
        const removedAsserts = p.removed.filter((l) => ASSERT.test(l.text));
        const addedAsserts = p.added.filter((l) => ASSERT.test(l.text)).length;
        if (removedAsserts.length > addedAsserts && removedAsserts.length - addedAsserts >= 2) {
          ev.push({ path, line: removedAsserts[0].line, side: "old", note: `${removedAsserts.length - addedAsserts} more assertions removed than added` });
        }
      }
    }
    push("tests-weakened", "Tests weakened", "Skipped tests, assertions that cannot fail, or files that lost assertions on balance.", 4, 24, ev);
  }

  // 5. Stubs and deferrals.
  {
    const ev: Evidence[] = [];
    for (const path of codePaths) {
      const added = parsed.get(path)?.added ?? [];
      for (let i = 0; i < added.length; i++) {
        const l = added[i];
        if (STUB.test(l.text)) ev.push({ path, line: l.line, side: "new", note: l.text.trim().slice(0, 80) });
        else if (ext(path) === "py" && /^\s*pass\s*$/.test(l.text) && /^\s*(def|class)\b/.test(added[i - 1]?.text ?? "")) ev.push({ path, line: l.line, side: "new", note: "empty body" });
      }
    }
    push("stubs", "Stubs and deferrals", "TODO, placeholder, for now, not implemented: work the PR says it did but left for later.", 3, 18, ev);
  }

  // 6. Commented-out code.
  {
    const ev: Evidence[] = [];
    for (const path of codePaths) {
      const added = parsed.get(path)?.added ?? [];
      let run = 0;
      let start = 0;
      const flush = () => {
        if (run >= 3) ev.push({ path, line: start, side: "new", note: `${run} lines of commented-out code` });
        run = 0;
      };
      for (const l of added) {
        const c = commentText(path, l.text);
        // Doc comments (///, //!, docstrings) are prose by intent; skip them.
        const doc = /^\s*(\/\/[/!]|"""|''')/.test(l.text);
        const codeLike = c !== null && !doc && looksLikeCode(c);
        if (codeLike) {
          if (run === 0) start = l.line;
          run++;
        } else flush();
      }
      flush();
    }
    push("commented-code", "Commented-out code", "Blocks of code left behind as comments instead of deleted.", 2, 10, ev);
  }

  // 7. Duplicated added blocks.
  {
    const ev: Evidence[] = [];
    const shingles = new Map<string, { path: string; line: number }[]>();
    for (const path of codePaths) {
      const added = (parsed.get(path)?.added ?? []).map((l) => ({ line: l.line, norm: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.norm.length >= 12 && /[A-Za-z]/.test(l.norm));
      for (let i = 0; i + 6 <= added.length; i++) {
        const key = added.slice(i, i + 6).map((l) => l.norm).join("\n");
        shingles.set(key, [...(shingles.get(key) ?? []), { path, line: added[i].line }]);
      }
    }
    const seen = new Set<string>();
    let weighted = 0;
    for (const places of shingles.values()) {
      if (places.length < 2) continue;
      const distinct = places.filter((p, i) => places.findIndex((q) => q.path === p.path && Math.abs(q.line - p.line) < 40) === i);
      if (distinct.length < 2) continue;
      const key = `${distinct[0].path}:${Math.floor(distinct[0].line / 20)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Repeated test setup is ordinary; the same block twice in production code is not.
      const testsOnly = distinct.every((p) => TEST_PATH.test(p.path));
      weighted += testsOnly ? 1 : 3;
      ev.push({ path: distinct[0].path, line: distinct[0].line, side: "new", note: `same 6 lines also at ${distinct.slice(1, 3).map((p) => `${p.path.split("/").pop()}:${p.line}`).join(", ")}${testsOnly ? " (tests)" : ""}` });
    }
    ev.sort((a, b) => Number(a.note.endsWith("(tests)")) - Number(b.note.endsWith("(tests)")));
    push("duplication", "Duplicated blocks", "Six or more identical added lines in two places. Models paste; people extract. Test-only repeats count less.", 3, 18, ev, weighted);
  }

  // 8. Scope: modules the title and description never mention.
  {
    const ev: Evidence[] = [];
    const text = `${input.title}\n${input.body}`.toLowerCase();
    const groups = new Map<string, ChangedFile[]>();
    for (const f of input.files) {
      const mod = input.moduleOf?.get(f.path) ?? f.path.split("/").slice(0, 2).join("/");
      groups.set(mod, [...(groups.get(mod) ?? []), f]);
    }
    for (const [mod, list] of groups) {
      if (/^(docs?|\.github|examples?)\b/i.test(mod) || /lock$/.test(mod)) continue;
      const tokens = mod.toLowerCase().split(/[/_.-]+/).filter((t) => t.length >= 3 && !["src", "lib", "app", "main", "pkg", "internal", "components", "packages"].includes(t));
      const mentioned = tokens.length === 0 || tokens.some((t) => text.includes(t));
      if (mentioned) continue;
      const biggest = [...list].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))[0];
      ev.push({ path: biggest.path, line: null, side: "new", note: `${mod}: ${list.length} file${list.length === 1 ? "" : "s"}, +${list.reduce((n, f) => n + f.additions, 0)} -${list.reduce((n, f) => n + f.deletions, 0)}, not mentioned in the title or description` });
    }
    push("scope", "Outside the stated scope", "Modules the title and description never mention. Scope creep is the most common AI PR problem.", 2, 12, ev);
  }

  // 9. Description shape.
  const aiAttributed = AI_ATTRIBUTION.test(input.body);
  {
    const ev: Evidence[] = [];
    const headers = [...new Set((input.body.match(new RegExp(TEMPLATE_HEADERS.source, "gimu")) ?? []).map((h) => h.trim().replace(/^#+\s*/, "").toLowerCase()))];
    if (headers.length >= 3) ev.push({ path: "", line: null, side: "new", note: `templated sections: ${headers.slice(0, 5).join(", ")}` });
    const emoji = (input.body.match(/\p{Extended_Pictographic}/gu) ?? []).length;
    if (emoji >= 4) ev.push({ path: "", line: null, side: "new", note: `${emoji} emoji in the description` });
    const changed = stats.addedLines + stats.removedLines;
    if (stats.bodyWords > 700 && stats.bodyWords > changed / 4) ev.push({ path: "", line: null, side: "new", note: `${stats.bodyWords} words of description for ${changed} changed lines` });
    push("description", "Description shape", "Templated sections, emoji bullets, and word counts out of proportion to the diff.", 2, 6, ev);
  }

  // 10. Over-commenting and a docstring on everything.
  {
    const ev: Evidence[] = [];
    if (stats.addedCode >= 80 && stats.addedComments / Math.max(1, stats.addedCode) >= 0.35) {
      const worst = codePaths
        .map((path) => {
          const added = parsed.get(path)?.added ?? [];
          const comments = added.filter((l) => commentText(path, l.text) !== null).length;
          return { path, comments, code: added.length - comments };
        })
        .filter((f) => f.code >= 20)
        .sort((a, b) => b.comments / Math.max(1, b.code) - a.comments / Math.max(1, a.code))[0];
      ev.push({ path: worst?.path ?? codePaths[0], line: null, side: "new", note: `${stats.addedComments} comment lines for ${stats.addedCode} code lines (${Math.round((100 * stats.addedComments) / stats.addedCode)}%)` });
    }
    let fns = 0;
    let documented = 0;
    for (const path of nonTestCode) {
      const added = parsed.get(path)?.added ?? [];
      for (let i = 0; i < added.length; i++) {
        if (!/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|def|function)\s+\w+/.test(added[i].text)) continue;
        fns++;
        const before = added.slice(Math.max(0, i - 3), i).map((l) => l.text);
        const after = added.slice(i + 1, i + 3).map((l) => l.text);
        if (before.some((t) => /^\s*(\/\/\/|\/\*\*|##?)/.test(t)) || after.some((t) => /^\s*("""|''')/.test(t))) documented++;
      }
    }
    if (fns >= 10 && documented / fns >= 0.9) ev.push({ path: nonTestCode[0] ?? "", line: null, side: "new", note: `${documented} of ${fns} new functions carry a doc comment, private ones included` });
    push("over-commenting", "Over-commented", "Far more comment than code, or a docstring on every function including private helpers.", 3, 8, ev);
  }

  signals.sort((a, b) => b.score - a.score);
  const raw = signals.reduce((n, s) => n + s.score, 0);
  // Bigger diffs earn more hits by chance; damp by size before saturating.
  const density = raw / Math.sqrt(Math.max(200, stats.addedLines) / 200);
  const score = Math.round(100 * (1 - Math.exp(-density / 22)));
  const verdict = score < 20 ? "Reads hand-made" : score < 45 ? "Some polish needed" : score < 70 ? "Heavy AI residue" : "Reads like unedited generation";
  return { score, verdict, signals, stats, aiAttributed };
}
