// Local integration regression: requires real Git, Bash, Node 24 and gitleaks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(source, ".githooks/pre-push"), "utf8");
const files = hook.match(/^CONTRACT_TESTS=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
const temporary = mkdtempSync(join(tmpdir(), "ci-history-regression-"));
const repo = join(temporary, "ci-actions");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^NODE_TEST_CONTEXT$/.test(key)));
const config = join(temporary, "empty-config");
writeFileSync(config, "");
Object.assign(env, {
  GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
  GIT_AUTHOR_NAME: "History fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "History fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const execute = (command, args, input) => spawnSync(command, args, {
  cwd: repo, env, input, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
});
const git = (...args) => {
  const result = execute("git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  mkdirSync(repo);
  assert.equal(execute("gitleaks", ["version"]).status, 0, "real gitleaks is required");
  const template = join(temporary, "empty-template");
  mkdirSync(template);
  git("init", `--template=${template}`);
  put(join(repo, ".githooks/pre-push"), hook);
  put(join(repo, ".githooks/run-contract-tests.mjs"), readFileSync(join(source, ".githooks/run-contract-tests.mjs")));
  for (const file of files) put(join(repo, file), 'import {test} from "node:test"; test("real fixture assertion", () => {});\n');
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const actualCommon = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: source, encoding: "utf8" }).stdout.trim();
  const security = readFileSync(join(dirname(actualCommon), "../infra-iac/hooks/lib/checks.sh"));
  put(join(dirname(common), "../infra-iac/hooks/lib/checks.sh"), security);
  git("add", ".");
  git("commit", "-m", "Clean base");
  const base = git("rev-parse", "HEAD");
  // Synthetic, never-issued token assembled at runtime to avoid checking a secret into source.
  const canary = ["gh", "p_", createHash("sha256").update("committed-only-canary").digest("hex").slice(0, 36)].join("");
  put(join(repo, "canary.env"), `CANARY_TOKEN=${canary}\n`);
  git("add", "canary.env");
  const other = git("commit-tree", `${base}^{tree}`, "-m", "Independent parent");
  const merge = git("commit-tree", git("write-tree"), "-p", base, "-p", other, "-m", "Merge-only canary");
  git("update-ref", "HEAD", merge, base);
  git("rm", "canary.env");
  git("commit", "-m", "Clean tip still carries secret history");
  assert.equal(git("status", "--porcelain"), "", "index and worktree must be clean");
  assert.equal(execute("gitleaks", ["protect", "--staged", "--redact", "--no-banner"]).status, 0, "staged-only scan must miss the canary");
  const head = git("rev-parse", "HEAD");
  for (const [name, remote] of [["existing branch", base], ["new branch", "0".repeat(40)]]) {
    const result = execute("bash", [".githooks/pre-push"], `${head} ${head} refs/heads/publication ${remote}\n`);
    assert.notEqual(result.status, 0, `${name}: committed secret passed the gate with a clean index`);
    assert.match(result.stderr, /leaks found/, `${name}: must fail from real history detection, not another prerequisite`);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(canary), "secret must be redacted");
    console.log(`PASS ${name}: real gitleaks rejected merge-only/deleted canary, clean index, redacted output`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
