// The diffmap viewer, run by the host entry: diffmap's static gist app
// (github.com/tanishqkancharla/diffmap, MIT) built at a pinned commit with a
// small patch, and a script that builds the gist-shaped payload it renders
// from a spec and a worktree, using diffmap's own source. The server serves
// both from its HTTP routes, so the Map tab is diffmap itself.

export const DIFFMAP_REPO = "https://github.com/tanishqkancharla/diffmap.git";
export const DIFFMAP_COMMIT = "973e2c932f8c1871cdff01e4bae55c877269822a";

/**
 * The gist app reads its route from the path and its gist from api.github.com.
 * Served under a plugin route, it takes its label from ?label=, fetches
 * gist.json beside itself with the same query, and keys saved comments by
 * ?review= so reviews do not share them.
 */
export const VIEWER_PATCH = `diff --git a/src/gist/GistApp.tsx b/src/gist/GistApp.tsx
index 02cdc1c..4517aaf 100644
--- a/src/gist/GistApp.tsx
+++ b/src/gist/GistApp.tsx
@@ -248,6 +248,8 @@ async function loadView(
 }
 
 function readRoute(): GistRoute {
+  // bb Review Desk: one locally built payload per page, named by ?label=, whatever the path prefix.
+  return { kind: "gist", gistId: new URLSearchParams(window.location.search).get("label") ?? "local", file: undefined };
   const rewritten = rewritePiGistUrl(
     window.location.pathname,
     window.location.hash,
diff --git a/src/gist/fetchGist.ts b/src/gist/fetchGist.ts
index f52c07d..b80250b 100644
--- a/src/gist/fetchGist.ts
+++ b/src/gist/fetchGist.ts
@@ -49,7 +49,7 @@ export async function loadGistMarkdown(
   fileName: string | undefined,
   signal?: AbortSignal,
 ): Promise<GistLoadResult> {
-  const response = await fetch(\`https://api.github.com/gists/\${gistId}\`, {
+  const response = await fetch(new URL(\`gist.json\${window.location.search}\`, document.baseURI), {
     headers: { Accept: "application/vnd.github+json" },
     signal,
   }).catch((cause: unknown) => cause);
diff --git a/src/viewer/ViewerApp.tsx b/src/viewer/ViewerApp.tsx
index 0d87b72..2529351 100644
--- a/src/viewer/ViewerApp.tsx
+++ b/src/viewer/ViewerApp.tsx
@@ -95,7 +95,7 @@ export function ViewerApp(props: {
   const contentRef = useRef<HTMLDivElement>(null);
   // localStorage is per origin, so the path names the document: a gist file, a GitHub spec, or a local server's only page.
   const comments = useCommentStore(
-    \`diffmap-comments:\${window.location.pathname}\`,
+    \`diffmap-comments:\${window.location.pathname}\${new URLSearchParams(window.location.search).get("review") ?? ""}\`,
   );
   const closed = useStyles(styles.closed);
   const closedCopy = useStyles(styles.closedCopy);
`;

export const BUILD_GIST_SCRIPT = `// Usage: tsx build-gist.mts <repoRoot> <spec.md> <out.json> <diffmapSrc> <label> <htmlUrl>
// The files \`diffmap share\` would put in a gist, built locally: the spec, the
// diffs its changes fences and revision references name, and the files its
// excerpts and plain references read.
import fs from "node:fs";
import path from "node:path";
const [repoRoot, specPath, outPath, src, label, htmlUrl] = process.argv.slice(2);
const { parseViewerDocument, collectFences } = await import(path.join(src, "parseViewer.ts"));
const { readDocumentChanges, readChanges } = await import(path.join(src, "git.ts"));
const { readSourceReference } = await import(path.join(src, "definitions.ts"));
const source = fs.readFileSync(specPath, "utf8");
const doc = parseViewerDocument(source, specPath);
if (doc instanceof Error) throw doc;
const changes = await readDocumentChanges(repoRoot, doc);
if (changes instanceof Error) throw changes;
for (const { rev } of doc.changeCards) {
  if (changes.has(rev)) continue;
  const c = await readChanges(repoRoot, rev);
  if (c instanceof Error) throw c;
  changes.set(rev, c);
}
const paths = new Set<string>();
for (const r of doc.references) if (r.kind === "file" && r.rev === undefined) paths.add(r.path);
for (const f of collectFences(doc.nodes)) if (f.kind === "file") paths.add(f.path);
const files: Record<string, string> = {};
for (const p of paths) {
  const read = readSourceReference(repoRoot, new URLSearchParams({ path: p }));
  if (read instanceof Error) throw read;
  files[p] = read.contents;
}
const name = path.basename(specPath);
fs.writeFileSync(outPath, JSON.stringify({
  id: label,
  html_url: htmlUrl,
  files: {
    [name]: { filename: name, truncated: false, content: source },
    "diffmap-changes.json": { filename: "diffmap-changes.json", truncated: false, content: JSON.stringify(Object.fromEntries(changes)) },
    "diffmap-files.json": { filename: "diffmap-files.json", truncated: false, content: JSON.stringify(files) },
  },
}));
`;
