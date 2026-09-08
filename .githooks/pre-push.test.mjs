import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(root, ".githooks/pre-push"), "utf8");
const runner = readFileSync(join(root, ".githooks/run-contract-tests.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
const selection = hook.match(/^CONTRACT_TESTS=\(\n([\s\S]*?)^\)/m)?.[1].trim().split(/\s+/);
const bash = process.platform === "win32"
  ? join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "bash";

function discoverTests(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules"].includes(entry.name)) return [];
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return discoverTests(join(directory, entry.name), `${relative}/`);
    return entry.isFile() && entry.name.endsWith(".test.mjs") ? [relative] : [];
  });
}

test("pre-push selection exactly matches CI and every contract, including hidden files", () => {
  const command = workflow.match(/      - name: Test action contracts\n        shell: bash\n        run: >-\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(command, "CI contract step must remain explicitly discoverable");
  const [node, flag, ...ciTests] = command.trim().split(/\s+/);
  assert.equal(node, "node");
  assert.equal(flag, "--test");
  assert.ok(selection?.length > 0);
  assert.equal(new Set(ciTests).size, ciTests.length);
  assert.deepEqual(selection, ciTests);
  assert.deepEqual([...ciTests].sort(), discoverTests(root).sort());
  assert.ok(ciTests.includes(".github/workflows/dependabot-auto-merge.contract.test.mjs"));
  assert.ok(ciTests.includes(".github/workflows/socket-security.contract.test.mjs"));
});

function put(path, content, executable = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

function fixture(t) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ci-pre-push-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const main = join(temporary, "workspace", "ci-actions");
  const linked = join(temporary, "linked-ci-actions");
  const security = join(temporary, "workspace", "infra-iac", "hooks", "lib", "checks.sh");
  const log = join(temporary, "executed.log");
  const bin = join(temporary, "bin");
  const emptyConfig = join(temporary, "empty-git-config");
  const emptyTemplate = join(temporary, "empty-template");
  mkdirSync(main, { recursive: true });
  mkdirSync(emptyTemplate);
  put(emptyConfig, "");
  // Never inherit the publication repository or its hooks into disposable fixtures.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^GIT_/i.test(key) && !/^NODE_(TEST_CONTEXT|OPTIONS|V8_COVERAGE)$/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_AUTHOR_NAME: "Contract fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Contract fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    CONTRACT_LOG: log,
  });
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${bin}${process.platform === "win32" ? ";" : ":"}${env[pathKey]}`;
  const execute = (command, args, cwd = main) => spawnSync(command, args, {
    cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  const git = (...args) => {
    const result = execute("git", args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", `--template=${emptyTemplate}`);
  put(join(main, ".githooks/pre-push"), hook, true);
  put(join(main, ".githooks/run-contract-tests.mjs"), runner);
  for (const file of selection) {
    // Exercise real Node assertions for the complete selection without recursively
    // invoking this behavior suite in the nested fixture repository.
    put(join(main, file), `import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
test(${JSON.stringify(`real contract ${file}`)}, () => {
  appendFileSync(process.env.CONTRACT_LOG, ${JSON.stringify(`test:${file}\n`)});
  assert.equal(2 + 2, 4);
});
`);
  }
  put(security, "pipeline_security() { printf 'security\\n' >> \"$CONTRACT_LOG\"; }\n");
  put(join(bin, "gitleaks"), "#!/usr/bin/env bash\nexit 0\n", true);
  git("add", ".");
  git("commit", "-m", "Fixture contract gate");
  git("worktree", "add", "-b", "fixture-linked", linked);
  const originalHook = join(main, ".git/hooks/pre-push");
  put(originalHook, "#!/usr/bin/env bash\nprintf 'original hook must survive\\n'\n", true);
  const originalConfig = readFileSync(join(main, ".git/config"), "utf8");
  return {
    main, linked, security, bin, execute,
    invoke: (cwd = main) => execute(bash, [".githooks/pre-push"], cwd),
    lines: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    unchanged: () => {
      assert.equal(readFileSync(join(main, ".git/config"), "utf8"), originalConfig);
      assert.equal(readFileSync(originalHook, "utf8"), "#!/usr/bin/env bash\nprintf 'original hook must survive\\n'\n");
      assert.equal(git("config", "--local", "--list").includes("core.hookspath="), false);
    },
  };
}

for (const topology of ["main", "linked"]) {
  test(`hook runs security before every real contract in a ${topology} worktree`, (t) => {
    const f = fixture(t);
    const result = f.invoke(f[topology]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(f.lines()[0], "security");
    assert.deepEqual(f.lines().slice(1).sort(), selection.map((file) => `test:${file}`).sort());
    assert.match(result.stdout, new RegExp(`# tests ${selection.length}\\b`));
    f.unchanged();
  });
}

for (const failure of ["missing library", "missing function", "failed security", "invalid shell", "wrong Node"]) {
  test(`hook fails closed before contracts: ${failure}`, (t) => {
    const f = fixture(t);
    if (failure === "missing library") rmSync(f.security);
    if (failure === "missing function") put(f.security, "other_function() { return 0; }\n");
    if (failure === "failed security") put(f.security, "pipeline_security() { printf 'security\\n' >> \"$CONTRACT_LOG\"; return 37; }\n");
    if (failure === "invalid shell") put(f.security, "pipeline_security() {\n");
    if (failure === "wrong Node") put(join(f.bin, "node"), "#!/usr/bin/env bash\nprintf '22\\n'\n", true);
    const result = f.invoke(f.linked);
    assert.notEqual(result.status, 0, result.stdout);
    if (failure === "failed security") assert.equal(result.status, 37);
    assert.deepEqual(f.lines(), failure === "failed security" ? ["security"] : []);
    f.unchanged();
  });
}

for (const mode of ["assertion", "missing", "empty", "skipped", "todo", "early exit", "syntax"]) {
  test(`hidden workflow contract ${mode} cannot produce a successful hook`, (t) => {
    const f = fixture(t);
    const target = join(f.linked, ".github/workflows/socket-security.contract.test.mjs");
    if (mode === "missing") rmSync(target);
    else put(target, {
      assertion: 'import {test} from "node:test"; import assert from "node:assert/strict"; test("failed contract", () => assert.fail("fixture failure"));\n',
      empty: "",
      skipped: 'import {test} from "node:test"; test.skip("omitted contract", () => {});\n',
      todo: 'import {test} from "node:test"; test.todo("pending contract");\n',
      "early exit": "process.exit(0);\n",
      syntax: "import {\n",
    }[mode]);
    const result = f.invoke(f.linked);
    assert.notEqual(result.status, 0, `${mode}: ${result.stdout}`);
    assert.equal(f.lines()[0], "security");
    assert.match(result.stderr, /ci-actions pre-push:/);
    f.unchanged();
  });
}

test("test runner rejects empty, duplicate, missing and escaping selections", (t) => {
  const f = fixture(t);
  for (const files of [[], [selection[0], selection[0]], ["missing.test.mjs"], ["../outside.test.mjs"], ["/outside.test.mjs"]]) {
    const result = f.execute(process.execPath, [".githooks/run-contract-tests.mjs", ...files]);
    assert.notEqual(result.status, 0, JSON.stringify(files));
    assert.match(result.stderr, /ci-actions pre-push:/);
    assert.deepEqual(f.lines(), []);
  }
  f.unchanged();
});
