import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(root, ".githooks/pre-push"), "utf8");
const runner = readFileSync(join(root, ".githooks/run-contract-tests.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
const canonicalEol = (source) => source.replace(/\r\n/g, "\n");
function hookSelection(source) {
  const block = canonicalEol(source).match(/^CONTRACT_TESTS=\(\n([\s\S]*?)^\)/m)?.[1];
  assert.ok(block, "hook contract selection must remain explicitly discoverable");
  return block.trim().split(/\s+/);
}
function ciSelection(source) {
  const command = canonicalEol(source).match(/      - name: Test action contracts\n        shell: bash\n        run: >-\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(command, "CI contract step must remain explicitly discoverable");
  const [node, flag, ...files] = command.trim().split(/\s+/);
  assert.equal(node, "node");
  assert.equal(flag, "--test");
  return files;
}
const selection = hookSelection(hook);
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
  const ciTests = ciSelection(workflow);
  assert.ok(selection?.length > 0);
  assert.equal(new Set(ciTests).size, ciTests.length);
  assert.deepEqual(selection, ciTests);
  assert.deepEqual([...ciTests].sort(), discoverTests(root).sort());
  assert.ok(ciTests.includes(".github/workflows/dependabot-auto-merge.contract.test.mjs"));
  assert.ok(ciTests.includes(".github/workflows/socket-security.contract.test.mjs"));
  assert.ok(existsSync(join(root, ".githooks/history-regression.mjs")), "real local security integration is required separately from Node-only CI");
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /node \.githooks\/history-regression\.mjs/);
});

test("LF and CRLF parsing preserves exact contract selection and rejects semantic drift", () => {
  for (const eol of ["\n", "\r\n"]) {
    const hookText = canonicalEol(hook).replace(/\n/g, eol);
    const ciText = canonicalEol(workflow).replace(/\n/g, eol);
    assert.deepEqual(hookSelection(hookText), selection);
    assert.deepEqual(ciSelection(ciText), selection);
    assert.throws(() => ciSelection(ciText.replace("node --test", "node --check")));
    assert.throws(() => hookSelection(hookText.replace("CONTRACT_TESTS=(", "EMPTY_SELECTION=(")));
    assert.notDeepEqual(ciSelection(ciText.replace("          ci-admission/cloud.test.mjs", "          omitted.test.mjs")), selection);
  }
});

test("only the executable native hook requires LF checkout", () => {
  assert.equal(canonicalEol(readFileSync(join(root, ".gitattributes"), "utf8")).trim(), "/.githooks/pre-push text eol=lf");
  assert.doesNotMatch(hook, /\r/);
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
  const execute = (command, args, cwd = main, input) => spawnSync(command, args, {
    cwd, env, input, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  const git = (...args) => {
    const result = execute("git", args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", `--template=${emptyTemplate}`);
  git("config", "core.autocrlf", "true");
  put(join(main, ".gitattributes"), readFileSync(join(root, ".gitattributes"), "utf8"));
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
  put(join(bin, "gitleaks"), "#!/usr/bin/env bash\nprintf 'history:%s\\n' \"$*\" >> \"$CONTRACT_LOG\"\n", true);
  git("add", ".");
  git("commit", "-m", "Fixture contract gate");
  git("worktree", "add", "-b", "fixture-linked", linked);
  assert.doesNotMatch(readFileSync(join(linked, ".githooks/pre-push"), "utf8"), /\r/);
  assert.match(readFileSync(join(linked, ".githooks/run-contract-tests.mjs"), "utf8"), /\r\n/);
  const head = git("rev-parse", "HEAD");
  const update = `${head} ${head} refs/heads/publication ${"0".repeat(40)}\n`;
  const originalHook = join(main, ".git/hooks/pre-push");
  put(originalHook, "#!/usr/bin/env bash\nprintf 'original hook must survive\\n'\n", true);
  const originalConfig = readFileSync(join(main, ".git/config"), "utf8");
  return {
    main, linked, security, bin, execute, git, head, update, env,
    invoke: (cwd = main, input = update) => execute(bash, [".githooks/pre-push"], cwd, input),
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
    assert.equal(f.lines()[1], `history:git --redact --no-banner --timeout 60 --log-opts=--full-history --diff-merges=first-parent ${f.head} .`);
    assert.deepEqual(f.lines().slice(2).sort(), selection.map((file) => `test:${file}`).sort());
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
    const reason = {
      "missing library": /shared security library unavailable/,
      "missing function": /shared security library defines no pipeline_security/,
      "wrong Node": /Node 24 is required/,
    }[failure];
    if (reason) assert.match(result.stderr, reason);
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

test("existing branches scan the exact advertised ancestor range, not the index", (t) => {
  const f = fixture(t);
  put(join(f.main, "change.txt"), "committed change\n");
  f.git("add", "change.txt");
  f.git("commit", "-m", "Outgoing change");
  const head = f.git("rev-parse", "HEAD");
  const result = f.invoke(f.main, `HEAD ${head} refs/heads/publication ${f.head}\n`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(f.lines()[1], `history:git --redact --no-banner --timeout 60 --log-opts=--full-history --diff-merges=first-parent ${f.head}..${head} .`);
  assert.equal(f.git("status", "--porcelain"), "");
  f.unchanged();
});

test("all advertised destinations are scanned before contracts", (t) => {
  const f = fixture(t);
  const result = f.invoke(f.main, f.update + f.update.replace("refs/heads/publication", "refs/heads/second"));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(f.lines().slice(0, 3), ["security", ...Array(2).fill(`history:git --redact --no-banner --timeout 60 --log-opts=--full-history --diff-merges=first-parent ${f.head} .`)]);
});

test("empty, malformed, unrelated, unavailable and oversized updates fail closed, each naming its reason", (t) => {
  const f = fixture(t);
  const unrelated = f.git("commit-tree", `${f.head}^{tree}`, "-m", "Unrelated root");
  const tree = f.git("rev-parse", `${f.head}^{tree}`);
  f.git("tag", "-a", "-m", "Fixture tag", "fixture-tag");
  const tag = f.git("rev-parse", "fixture-tag");
  const zero = "0".repeat(40);
  const malformed = /invalid advertised branch update or non-HEAD source/;
  const limits = /advertised updates exceed gate limits/;
  // A refusal under set -e can exit with nothing on stderr; git then prints only
  // "failed to push some refs". Each row pins the reason, not just the status.
  const invalid = [
    ["", /advertised updates are required; git lists none/],
    ["\n", malformed],
    [f.update.trim(), /incomplete or timed-out advertised updates/],
    [`HEAD ${f.head}\n`, malformed],
    [f.update + "extra\n", malformed],
    [f.update.replace(f.head, "--all"), /invalid local ref/],
    // Passes the refs/heads/* shape test, so only check-ref-format can refuse it.
    [f.update.replace(f.head, "refs/heads/fixture-linked~0"), /invalid local ref/],
    [f.update.replace(f.head, "refs/heads/missing"), /advertised local ref does not name the advertised commit/],
    [f.update.replace(`${f.head} ${f.head}`, `HEAD ${zero}`), malformed],
    [f.update.replace("refs/heads/publication", "refs/tags/publication"), malformed],
    [f.update.replace("refs/heads/publication", "refs/heads/bad..ref"), /invalid destination branch name/],
    [f.update.replace(zero, "a".repeat(40)), /refs\/heads\/publication: remote tip a{12} is not in local history/],
    [f.update.replace(zero, unrelated), new RegExp(`remote tip ${unrelated.slice(0, 12)} is not an ancestor of HEAD`)],
    [f.update.replace(zero, tree), new RegExp(`remote tip ${tree.slice(0, 12)} is a tree, not a commit`)],
    [f.update.replace(zero, tag), new RegExp(`remote tip ${tag.slice(0, 12)} is a tag, not a commit`)],
    [f.update.replace(zero, f.head), /empty or oversized outgoing history/],
    [f.update + f.update, /duplicate advertised destination/],
    [f.update.replace(f.head, "x".repeat(4097)), limits],
    [Array.from({ length: 17 }, (_, i) => f.update.replace("publication", `branch-${i}`)).join(""), limits],
  ];
  for (const [input, reason] of invalid) {
    const result = f.invoke(f.linked, input);
    const label = JSON.stringify(input.slice(0, 180));
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, reason, `${label}: ${result.stderr}`);
    assert.deepEqual(f.lines(), [], "invalid ranges must not run security or contracts");
  }
  f.unchanged();
});

// The rows above feed stdin by hand. These drive a real `git push` through the
// hook, so git itself decides which updates it advertises.
function publication(t) {
  const f = fixture(t);
  const remote = join(dirname(dirname(f.main)), "publication.git");
  f.git("init", "--bare", remote);
  // Seeding runs the fixture's original hook, not the gate.
  f.git("push", remote, "HEAD:refs/heads/publication");
  const commit = (name) => {
    put(join(f.main, `${name}.txt`), `${name}\n`);
    f.git("add", `${name}.txt`);
    f.git("commit", "-m", name);
    return f.git("rev-parse", "HEAD");
  };
  return {
    f, remote, commit,
    push: (options, refspec) => f.execute("git", ["-c", "core.hooksPath=.githooks", "push", ...options, remote, refspec]),
    tip: (ref = "refs/heads/publication") => f.git("--git-dir", remote, "rev-parse", "--verify", "--quiet", ref),
  };
}

function rewritten(t) {
  const p = publication(t);
  const published = p.commit("published");
  p.f.git("push", p.remote, "HEAD:refs/heads/publication");
  p.f.git("reset", "--hard", p.f.head);
  const rewrite = p.commit("rewrite");
  return { ...p, published, rewrite };
}

test("a real fast-forward push scans exactly the published range", (t) => {
  const p = publication(t);
  const next = p.commit("forward");
  const result = p.push([], "HEAD:refs/heads/publication");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(p.f.lines()[1], `history:git --redact --no-banner --timeout 60 --log-opts=--full-history --diff-merges=first-parent ${p.f.head}..${next} .`);
  assert.equal(p.tip(), next);
  p.f.unchanged();
});

for (const [shape, options, refspec] of [
  ["--force", ["--force"], "HEAD:refs/heads/publication"],
  ["--force-with-lease", null, "HEAD:refs/heads/publication"],
  ["a +refspec", [], "+HEAD:refs/heads/publication"],
]) {
  test(`a real ${shape} push of rewritten history is refused with its reason`, (t) => {
    const p = rewritten(t);
    const result = p.push(options ?? [`--force-with-lease=refs/heads/publication:${p.published}`], refspec);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(`refs/heads/publication: remote tip ${p.published.slice(0, 12)} is not an ancestor of HEAD`));
    assert.match(result.stderr, /Merge the remote tip into HEAD, or publish the rewrite as a new branch/);
    assert.deepEqual(p.f.lines(), [], "a refused rewrite must not run security or contracts");
    assert.equal(p.tip(), p.published);
    p.f.unchanged();
  });
}

test("both remedies the rewrite refusal names are accepted by a real push", (t) => {
  const p = rewritten(t);
  const branch = p.push([], "HEAD:refs/heads/publication-rewrite");
  assert.equal(branch.status, 0, `${branch.stdout}\n${branch.stderr}`);
  assert.equal(p.tip("refs/heads/publication-rewrite"), p.rewrite);
  p.f.git("merge", "--no-edit", p.published);
  const merged = p.f.git("rev-parse", "HEAD");
  const merge = p.push([], "HEAD:refs/heads/publication");
  assert.equal(merge.status, 0, `${merge.stdout}\n${merge.stderr}`);
  assert.equal(p.tip(), merged);
  p.f.unchanged();
});

for (const shape of ["non-fast-forward", "stale lease", "up to date"]) {
  test(`a real ${shape} push reaches the gate with no advertised update and says why`, (t) => {
    const p = rewritten(t);
    const result = {
      "non-fast-forward": () => p.push([], "HEAD:refs/heads/publication"),
      "stale lease": () => p.push([`--force-with-lease=refs/heads/publication:${p.f.head}`], "HEAD:refs/heads/publication"),
      "up to date": () => p.push([], `${p.published}:refs/heads/publication`),
    }[shape]();
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /advertised updates are required; git lists none when the push is already up to date, non-fast-forward, or holds a stale lease/);
    assert.deepEqual(p.f.lines(), []);
    assert.equal(p.tip(), p.published);
    p.f.unchanged();
  });
}

test("a real --mirror push that only deletes reaches the gate with no advertised update and is refused", (t) => {
  // Git omits a deletion with no local peer from pre-push stdin, so this push arrives
  // empty. It is the reason empty input is refused rather than read as a no-op.
  const p = publication(t);
  p.f.git("push", "--mirror", p.remote); // Seeding runs the fixture's original hook.
  p.f.git("--git-dir", p.remote, "update-ref", "refs/heads/doomed", p.f.head);
  const result = p.f.execute("git", ["-c", "core.hooksPath=.githooks", "push", "--mirror", p.remote]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /and none for a --mirror push that only deletes, so empty input is refused/);
  assert.deepEqual(p.f.lines(), []);
  assert.equal(p.tip("refs/heads/doomed"), p.f.head);
  p.f.unchanged();
});

for (const options of [[], ["--force"]]) {
  test(`a real push over a remote tip never fetched is refused as unavailable (${options.join(" ") || "no force"})`, (t) => {
    const p = rewritten(t);
    const remoteOnly = p.f.git("--git-dir", p.remote, "commit-tree", `${p.published}^{tree}`, "-p", p.published, "-m", "Remote only");
    p.f.git("--git-dir", p.remote, "update-ref", "refs/heads/publication", remoteOnly);
    const result = p.push(options, "HEAD:refs/heads/publication");
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(`remote tip ${remoteOnly.slice(0, 12)} is not in local history; fetch and integrate it`));
    assert.deepEqual(p.f.lines(), []);
    assert.equal(p.tip(), remoteOnly);
    p.f.unchanged();
  });
}

test("a missing node is refused by name, not by a silent command-not-found exit", {
  skip: process.platform === "win32" && "a node-less PATH is built from symlinks",
}, (t) => {
  const f = fixture(t);
  // bash, git and dirname are all the hook runs before its Node check.
  const nodeless = join(dirname(f.bin), "nodeless-bin");
  mkdirSync(nodeless);
  for (const tool of ["bash", "git", "dirname"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, `${tool} not found`);
    symlinkSync(found, join(nodeless, tool));
  }
  const result = spawnSync(join(nodeless, "bash"), [".githooks/pre-push"], {
    cwd: f.linked, env: { ...f.env, PATH: nodeless }, input: f.update, encoding: "utf8", timeout: 60_000,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Node 24 is required/);
  assert.deepEqual(f.lines(), []);
});

for (const stage of ["history scan", "contracts"]) {
  test(`HEAD moving during the ${stage} is refused by name`, (t) => {
    const f = fixture(t);
    const move = 'git commit -q --allow-empty -m "Moved while the gate ran"';
    if (stage === "history scan") put(join(f.bin, "gitleaks"), `#!/usr/bin/env bash\n${move}\n`, true);
    else put(join(f.linked, ".github/workflows/socket-security.contract.test.mjs"), `import { test } from "node:test";
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
test("moves HEAD", () => {
  appendFileSync(process.env.CONTRACT_LOG, "test:moved\\n");
  execSync(${JSON.stringify(move)});
});
`);
    const result = f.invoke(f.linked);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /HEAD moved while the gate ran/);
    if (stage === "contracts") assert.ok(f.lines().includes("test:moved"), "the second check runs after the contracts");
    f.unchanged();
  });
}

test("history scanner failure propagates without running contracts", (t) => {
  const f = fixture(t);
  put(join(f.bin, "gitleaks"), "#!/usr/bin/env bash\nprintf 'history-failed\\n' >> \"$CONTRACT_LOG\"\nexit 29\n", true);
  const result = f.invoke(f.linked);
  assert.equal(result.status, 29);
  assert.deepEqual(f.lines(), ["security", "history-failed"]);
  f.unchanged();
});

test("shallow history cannot authorize a partial scan", (t) => {
  const f = fixture(t);
  put(join(f.main, ".git/shallow"), `${f.head}\n`);
  const result = f.invoke(f.linked);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /complete history is required/);
  assert.deepEqual(f.lines(), []);
});

test("an open stdin pipe fails within the bounded read deadline", async (t) => {
  const f = fixture(t);
  const child = spawn(bash, [".githooks/pre-push"], { cwd: f.linked, env: f.env, timeout: 5000 });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  child.stdin.write(f.update); // Intentionally no EOF: must not authorize a partial batch.
  const result = await closed;
  assert.deepEqual(result, { status: 1, signal: null });
  assert.match(stderr, /timed-out advertised updates/);
  assert.deepEqual(f.lines(), []);
});
