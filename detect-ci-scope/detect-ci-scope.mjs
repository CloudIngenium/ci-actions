import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/i;
const MAX_PATHS = 10_000;

function lines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function normalizePath(value) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error(`Unsafe changed path: ${JSON.stringify(value)}`);
  }
  return path;
}

function pathMatches(path, rule) {
  const normalized = normalizePath(rule);
  if (normalized.endsWith("/**")) return path.startsWith(normalized.slice(0, -2));
  if (normalized.endsWith("/")) return path.startsWith(normalized);
  return path === normalized;
}

function docsOnly(paths) {
  return paths.length > 0 && paths.every((path) =>
    path.startsWith("docs/")
    || path.startsWith("runbooks/")
    || path.startsWith(".claude-plans/")
    || (!path.includes("/") && path.toLowerCase().endsWith(".md")));
}

function componentNames(paths, root) {
  const prefix = root ? `${normalizePath(root).replace(/\/+$/, "")}/` : "";
  if (!prefix) return [];
  return [...new Set(paths.flatMap((path) => {
    if (!path.startsWith(prefix)) return [];
    const name = path.slice(prefix.length).split("/")[0];
    return name ? [name] : [];
  }))].sort();
}

export function detectCiScope({
  baseSha,
  headSha,
  changedFiles,
  componentRoot = "",
  fullTriggerPaths = [],
  ignoredPaths = [],
  runGit = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
} = {}) {
  let raw = String(changedFiles || "");
  if (!raw) {
    if (!SHA.test(String(baseSha || "")) || !SHA.test(String(headSha || ""))) {
      return { paths: [], components: [], docsOnly: false, full: true, reason: "missing-diff-base" };
    }
    try {
      raw = runGit(["diff", "--name-only", `${baseSha}...${headSha}`]);
    } catch {
      return { paths: [], components: [], docsOnly: false, full: true, reason: "diff-failed" };
    }
  }

  const allPaths = [...new Set(lines(raw).map(normalizePath))].sort();
  if (allPaths.length === 0) {
    return { paths: [], components: [], docsOnly: false, full: true, reason: "empty-diff" };
  }
  if (allPaths.length > MAX_PATHS) {
    return { paths: [], components: [], docsOnly: false, full: true, reason: "diff-too-large" };
  }
  const full = allPaths.some((path) => fullTriggerPaths.some((rule) => pathMatches(path, rule)));
  const runtimePaths = allPaths.filter(
    (path) => !ignoredPaths.some((rule) => pathMatches(path, rule)),
  );
  return {
    paths: allPaths,
    components: componentNames(runtimePaths, componentRoot),
    docsOnly: docsOnly(allPaths),
    full,
    reason: full ? "full-trigger" : runtimePaths.length === 0 ? "ignored-only" : "scoped",
  };
}

function emit(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  if (output) appendFileSync(output, `${name}=${rendered}\n`);
  else process.stdout.write(`${name}=${rendered}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = detectCiScope({
    baseSha: process.env.CI_SCOPE_BASE_SHA,
    headSha: process.env.CI_SCOPE_HEAD_SHA,
    changedFiles: process.env.CI_SCOPE_CHANGED_FILES,
    componentRoot: process.env.CI_SCOPE_COMPONENT_ROOT,
    fullTriggerPaths: lines(process.env.CI_SCOPE_FULL_TRIGGER_PATHS),
    ignoredPaths: lines(process.env.CI_SCOPE_IGNORED_PATHS),
  });
  emit("changed_files_json", result.paths);
  emit("components_json", result.components);
  emit("docs_only", result.docsOnly);
  emit("full", result.full);
  emit("reason", result.reason);
}
