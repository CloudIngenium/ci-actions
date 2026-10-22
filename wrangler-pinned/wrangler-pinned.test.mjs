import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { tmpFixture } from "../lib/tmp-fixture.mjs";
import {
  DEFAULT_DIR, LOCKFILE_SHA256, PACKAGE_JSON_SHA256, PINNED_FILES, PNPM_TARBALL_SHA512, PNPM_VERSION, REGISTRY,
  WRANGLER_VERSION, isInside, isolatedEnv, isolationPaths, pnpmInstallArgs, provisionPnpm, resolveTarget, run, sha256File,
} from "./wrangler-pinned.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const real = (p) => realpathSync.native(p);
const dirLink = (target, link) => symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

// Only these names may reach npm or pnpm. Anything else is caller state leaking in.
const ALLOWED_ENV = new Set([
  "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "CI",
  "npm_config_userconfig", "npm_config_globalconfig", "npm_config_registry", "npm_config_cache",
  "npm_config_ignore_scripts", "npm_config_update_notifier", "npm_config_audit", "npm_config_fund",
  "PNPM_HOME", "PNPM_CONFIG_UPDATE_NOTIFIER", "PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "SystemDrive", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  // libuv adds these from the parent to any Windows child env that lacks them.
  "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "LOGONSERVER",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);
// Windows env names are case-insensitive, and libuv injects the upper-case form.
const ALLOWED_ENV_FOLDED = new Set([...ALLOWED_ENV].map((name) => name.toUpperCase()));
const leakedNames = (env) => Object.keys(env).filter((name) =>
  !(process.platform === "win32" ? ALLOWED_ENV_FOLDED.has(name.toUpperCase()) : ALLOWED_ENV.has(name)));

function runnerLayout() {
  const root = real(tmpFixture("wrangler-pinned"));
  const temp = path.join(root, "_temp");
  const workspace = path.join(root, "repo", "repo");
  mkdirSync(temp, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, temp, workspace };
}

/** Hostile copies of every file a caller could use to steer an install. */
function plantHostileFiles(dir, marker) {
  writeFileSync(path.join(dir, ".npmrc"),
    "registry=http://127.0.0.1:9/\n@cloudflare:registry=http://127.0.0.1:9/\n//127.0.0.1:9/:_authToken=fixture-not-a-secret\n");
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"),
    "packages: ['.']\nregistries:\n  default: http://127.0.0.1:9/\noverrides:\n  wrangler: 4.123.0\npnpmfile: hostile.cjs\n");
  writeFileSync(path.join(dir, "package.json"),
    JSON.stringify({
      name: "hostile", private: true, packageManager: "pnpm@9.0.0", workspaces: [DEFAULT_DIR], dependencies: { wrangler: "4.123.0" },
    }));
  const hook = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "pnpmfile ran");\nmodule.exports = { hooks: {} };\n`;
  writeFileSync(path.join(dir, ".pnpmfile.cjs"), hook);
  writeFileSync(path.join(dir, "hostile.cjs"), hook);
}

/**
 * A pnpm stand-in run through the real spawn path. It records what it was
 * given and lays out node_modules/wrangler as an install would.
 */
function stubPnpm(dir, { version = WRANGLER_VERSION, record }) {
  const script = path.join(dir, "pnpm-stub.mjs");
  writeFileSync(script, `
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cwd = process.cwd();
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd,
  env: process.env,
  files: readdirSync(cwd),
  userconfig: readFileSync(process.env.npm_config_userconfig, "utf8"),
  globalconfig: readFileSync(process.env.npm_config_globalconfig, "utf8"),
}));
const wrangler = join(cwd, "node_modules", "wrangler");
mkdirSync(join(wrangler, "bin"), { recursive: true });
writeFileSync(join(wrangler, "package.json"), JSON.stringify({ name: "wrangler", version: ${JSON.stringify(version)} }));
writeFileSync(join(wrangler, "bin", "wrangler.js"), "");
`);
  return script;
}

test("hash constants match the committed package.json and lockfile, which pin wrangler alone", () => {
  assert.equal(sha256File(path.join(here, "package.json")), PACKAGE_JSON_SHA256);
  assert.equal(sha256File(path.join(here, "pnpm-lock.yaml")), LOCKFILE_SHA256);
  assert.deepEqual(Object.keys(PINNED_FILES), ["package.json", "pnpm-lock.yaml"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")),
    { private: true, name: "d1-wrangler", dependencies: { wrangler: WRANGLER_VERSION } });

  const lock = readFileSync(path.join(here, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /^lockfileVersion: '9\.0'$/m);
  assert.match(lock, new RegExp(`^ {6}wrangler:\\n {8}specifier: ${WRANGLER_VERSION.replaceAll(".", "\\.")}\\n {8}version: ${WRANGLER_VERSION.replaceAll(".", "\\.")}$`, "m"));
  assert.doesNotMatch(lock, /tarball:|https?:\/\/|npm\.pkg\.github\.com/, "every package resolves from the default registry by integrity");
  assert.doesNotMatch(lock, /@cloudingenium\//);
  assert.doesNotMatch(lock, /^pnpmfileChecksum:|^patchedDependencies:|^overrides:/m);
  assert.match(PNPM_TARBALL_SHA512, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(REGISTRY, "https://registry.npmjs.org/");
  assert.equal(PNPM_VERSION, "11.13.0");
});

test("the pinned files are byte-exact on every checkout (no EOL conversion)", () => {
  const attributes = readFileSync(path.join(repoRoot, ".gitattributes"), "utf8").replace(/\r\n/g, "\n");
  assert.match(attributes, /^\/wrangler-pinned\/package\.json -text$/m);
  assert.match(attributes, /^\/wrangler-pinned\/pnpm-lock\.yaml -text$/m);
  for (const name of Object.keys(PINNED_FILES)) {
    assert.doesNotMatch(readFileSync(path.join(here, name), "latin1"), /\r/, `${name} must stay LF`);
  }
});

test("the install directory defaults under RUNNER_TEMP and refuses the workspace", () => {
  const { temp, workspace } = runnerLayout();
  assert.equal(resolveTarget({ runnerTemp: temp, workspace }), path.join(temp, DEFAULT_DIR));
  assert.equal(resolveTarget({ runnerTemp: temp, workspace, dir: "nested/wr" }), path.join(temp, "nested", "wr"));
  assert.equal(resolveTarget({ runnerTemp: temp, workspace, dir: path.join(temp, "abs") }), path.join(temp, "abs"));

  assert.throws(() => resolveTarget({ runnerTemp: "", workspace }), /RUNNER_TEMP is not set/);
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace: "" }), /GITHUB_WORKSPACE is not set/);
  assert.throws(() => resolveTarget({ runnerTemp: "relative/temp", workspace }), /absolute/);
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace, dir: "." }), /strictly under RUNNER_TEMP/);
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace, dir: "../escape" }), /strictly under RUNNER_TEMP/);
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace, dir: path.join(workspace, "wr") }), /strictly under RUNNER_TEMP/);
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace, dir: "a\nb" }), /control character/);
});

test("a directory inside the workspace is refused once resolved, through links and nesting", () => {
  // Self-hosted layouts can put the workspace under RUNNER_TEMP.
  const { temp } = runnerLayout();
  const workspace = path.join(temp, "ws");
  mkdirSync(workspace);
  for (const dir of ["ws", "ws/sub", path.join(workspace, "abs")]) {
    assert.throws(() => resolveTarget({ runnerTemp: temp, workspace, dir }), /overlaps GITHUB_WORKSPACE/, dir);
  }
  // A target that would contain the workspace (and be deleted with it).
  const nested = path.join(temp, "outer", "ws");
  mkdirSync(nested, { recursive: true });
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace: nested, dir: "outer" }), /overlaps GITHUB_WORKSPACE/);
  // A link under RUNNER_TEMP that points into the workspace.
  dirLink(workspace, path.join(temp, "link"));
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace, dir: "link/wr" }), /overlaps GITHUB_WORKSPACE/);
  // RUNNER_TEMP reached through a link resolves to the real directory, and a
  // workspace reached through a link is still the workspace.
  const { temp: temp2, workspace: ws2, root } = runnerLayout();
  const tempLink = path.join(root, "temp-link");
  dirLink(temp2, tempLink);
  assert.equal(resolveTarget({ runnerTemp: tempLink, workspace: ws2, dir: path.join(tempLink, "abs") }), path.join(temp2, "abs"));
  const inner = path.join(temp2, "ws");
  mkdirSync(inner);
  assert.throws(() => resolveTarget({ runnerTemp: temp2, workspace: path.join(tempLink, "ws"), dir: "ws/x" }), /overlaps GITHUB_WORKSPACE/);
});

test("isInside treats only a `..` segment as outside, on posix and win32", () => {
  const cases = [
    // [api, child, parent, inside]
    [path.posix, "/t/..x", "/t", true],
    [path.posix, "/t/..x/y", "/t", true],
    [path.posix, "/t/...", "/t", true],
    [path.posix, "/t/a/b", "/t", true],
    [path.posix, "/t", "/t", false],
    [path.posix, "/", "/t", false],
    [path.posix, "/x", "/t", false],
    [path.posix, "/t/../x", "/t", false],
    [path.posix, "/tx", "/t", false],
    [path.win32, "C:\\t\\..x", "C:\\t", true],
    [path.win32, "C:\\t\\a\\b", "C:\\t", true],
    [path.win32, "C:\\t", "C:\\t", false],
    [path.win32, "C:\\", "C:\\t", false],
    [path.win32, "C:\\x", "C:\\t", false],
    [path.win32, "D:\\t\\a", "C:\\t", false],
    [path.win32, "D:\\t", "C:\\t", false],
  ];
  for (const [api, child, parent, inside] of cases) {
    assert.equal(isInside(child, parent, api), inside, `${api === path.win32 ? "win32" : "posix"} ${child} in ${parent}`);
  }
});

test("a directory entry named `..x` is a real child, both under RUNNER_TEMP and around the workspace", () => {
  const { temp, workspace } = runnerLayout();
  assert.equal(resolveTarget({ runnerTemp: temp, workspace, dir: "..x" }), path.join(temp, "..x"));
  assert.equal(resolveTarget({ runnerTemp: temp, workspace, dir: "..x/wr" }), path.join(temp, "..x", "wr"));
  // A target that would contain a workspace named `..x` (and delete it with the install).
  const ws = path.join(temp, "outer", "..x");
  mkdirSync(ws, { recursive: true });
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace: ws, dir: "outer" }), /overlaps GITHUB_WORKSPACE/);
  // ..and a target inside it.
  assert.throws(() => resolveTarget({ runnerTemp: temp, workspace: ws, dir: "outer/..x/wr" }), /overlaps GITHUB_WORKSPACE/);
});

// pnpm is a stub here, so the planted pnpmfile and pnpm-workspace.yaml are never
// parsed: this test proves the argv, cwd, staged files and env pnpm receives. The
// real-install smoke in test.yml (action-contracts) proves pnpm ignores the files.
test("hostile caller files and env never reach the install's argv, cwd, files or env", async () => {
  const { root, temp, workspace } = runnerLayout();
  const marker = path.join(root, "PWNED");
  plantHostileFiles(workspace, marker);
  plantHostileFiles(temp, marker); // a parent of the install directory
  const preload = path.join(root, "preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "NODE_OPTIONS ran");\n`);
  const record = path.join(root, "record.json");
  const stub = stubPnpm(root, { record });
  const githubOutput = path.join(root, "github-output");
  writeFileSync(githubOutput, "");

  const env = {
    ...process.env,
    RUNNER_TEMP: temp,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: githubOutput,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
    npm_config_userconfig: path.join(workspace, ".npmrc"),
    "npm_config_@cloudflare:registry": "http://127.0.0.1:9/",
    npm_config__authToken: "fixture-not-a-secret",
    PNPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
    PNPM_CONFIG_STORE_DIR: path.join(root, "hostile-store"),
    NODE_AUTH_TOKEN: "fixture-not-a-secret",
    GITHUB_TOKEN: "fixture-not-a-secret",
    CF_API_TOKEN: "fixture-not-a-secret",
    CLOUDFLARE_API_TOKEN: "fixture-not-a-secret",
  };
  let provided;
  const outputs = await run({
    env,
    spawn: spawnSync,
    pnpmProvider: (args) => { provided = args; return stub; },
  });

  const target = path.join(temp, DEFAULT_DIR);
  const iso = isolationPaths(target);
  const seen = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(existsSync(marker), false, "no caller pnpmfile or NODE_OPTIONS preload ran");
  assert.equal(real(seen.cwd), real(target));
  assert.deepEqual(seen.argv, pnpmInstallArgs(iso));
  for (const flag of ["--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--ignore-workspace"]) {
    assert.ok(seen.argv.includes(flag), flag);
  }
  assert.equal(seen.argv[seen.argv.indexOf("--registry") + 1], REGISTRY);
  assert.deepEqual(seen.files.sort(), [".isolation", "package.json", "pnpm-lock.yaml"]);
  assert.equal(sha256File(path.join(target, "package.json")), PACKAGE_JSON_SHA256);
  assert.equal(sha256File(path.join(target, "pnpm-lock.yaml")), LOCKFILE_SHA256);
  assert.equal(seen.userconfig, "");
  assert.equal(seen.globalconfig, "");

  const leaked = leakedNames(seen.env);
  assert.deepEqual(leaked, [], "only allowlisted variables reach pnpm");
  assert.equal(seen.env.npm_config_registry, REGISTRY);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "npm_config_userconfig", "npm_config_globalconfig", "npm_config_cache"]) {
    assert.ok(real(seen.env[name]).startsWith(real(target) + path.sep), `${name} is inside the install directory`);
  }
  assert.doesNotMatch(JSON.stringify(seen.env), /fixture-not-a-secret|127\.0\.0\.1:9|hostile-store/);
  assert.deepEqual(leakedNames(provided.env), [], "npm sees the same isolation");

  const bin = path.join(target, "node_modules", "wrangler", "bin", "wrangler.js");
  assert.deepEqual(outputs, { "wrangler-bin": bin, "wrangler-dir": target, "wrangler-version": WRANGLER_VERSION });
  assert.ok(path.isAbsolute(outputs["wrangler-bin"]) && existsSync(outputs["wrangler-bin"]));
  assert.equal(readFileSync(githubOutput, "utf8"),
    `wrangler-bin=${bin}\nwrangler-dir=${target}\nwrangler-version=${WRANGLER_VERSION}\n`);
  // The caller's files are untouched.
  assert.match(readFileSync(path.join(workspace, "package.json"), "utf8"), /"hostile"/);
  assert.equal(readdirSync(workspace).includes("node_modules"), false);
});

test("an installed wrangler other than the pinned release is rejected", async () => {
  const { root, temp, workspace } = runnerLayout();
  const env = { ...process.env, RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: "" };
  const stub = stubPnpm(root, { version: "4.123.0", record: path.join(root, "record.json") });
  await assert.rejects(run({ env, pnpmProvider: () => stub }), /installed wrangler@4\.123\.0, expected wrangler@4\.124\.0/);

  const empty = path.join(root, "empty-stub.mjs");
  writeFileSync(empty, "");
  await assert.rejects(run({ env, pnpmProvider: () => empty }), /wrangler is not installed/);

  const failing = path.join(root, "failing-stub.mjs");
  writeFileSync(failing, "process.exit(3);\n");
  await assert.rejects(run({ env, pnpmProvider: () => failing }), /exited with 3/);
});

test("a wrangler that resolves outside the install directory is rejected", async () => {
  const { root, temp, workspace } = runnerLayout();
  const outside = path.join(root, "outside-wrangler");
  mkdirSync(path.join(outside, "bin"), { recursive: true });
  writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "wrangler", version: WRANGLER_VERSION }));
  writeFileSync(path.join(outside, "bin", "wrangler.js"), "");
  const stub = path.join(root, "link-stub.mjs");
  writeFileSync(stub, `
import { mkdirSync, symlinkSync } from "node:fs";
mkdirSync("node_modules");
symlinkSync(${JSON.stringify(outside)}, "node_modules/wrangler", process.platform === "win32" ? "junction" : "dir");
`);
  const env = { ...process.env, RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: "" };
  await assert.rejects(run({ env, pnpmProvider: () => stub }), /resolves outside the install directory/);
});

test("a tampered package.json or lockfile stops the action before any install", async () => {
  const { root, temp, workspace } = runnerLayout();
  const env = { ...process.env, RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: "" };
  for (const name of Object.keys(PINNED_FILES)) {
    const actionPath = path.join(root, `action-${name}`);
    cpSync(here, actionPath, { recursive: true });
    writeFileSync(path.join(actionPath, name), `${readFileSync(path.join(here, name), "utf8")}\n`);
    let called = false;
    await assert.rejects(run({ env, actionPath, pnpmProvider: () => { called = true; return ""; } }),
      new RegExp(`${name.replace(".", "\\.")} sha256 [0-9a-f]{64} does not match`));
    assert.equal(called, false, `${name}: pnpm was never provisioned`);
  }
});

test("pnpm is fetched by exact version from npmjs and its tarball checked, never taken from PATH", () => {
  const { root } = runnerLayout();
  const iso = isolationPaths(path.join(root, "target"));
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    // A tarball with the right name and the wrong bytes.
    writeFileSync(path.join(iso.pnpmCli, `pnpm-${PNPM_VERSION}.tgz`), "not pnpm");
    return { status: 0 };
  };
  const env = { PATH: "x" };
  assert.throws(() => provisionPnpm({ iso, env, spawn: fakeSpawn }), /tarball integrity sha512-\S+ is not the pinned one/);
  assert.equal(calls.length, 1, "nothing is installed from an unverified tarball");
  assert.equal(calls[0].command, process.execPath);
  assert.match(calls[0].args[0], /npm-cli\.js$/);
  assert.deepEqual(calls[0].args.slice(1), ["pack", `pnpm@${PNPM_VERSION}`, "--pack-destination", iso.pnpmCli, "--registry", REGISTRY,
    "--prefix", iso.pnpmCli, "--no-workspaces"]);
  assert.equal(calls[0].options.env, env);
});

test("the Windows environment keeps profile, temp and config inside the install directory", () => {
  const target = "D:\\a\\_temp\\d1-wrangler";
  const env = isolatedEnv({
    target,
    platform: "win32",
    execPath: "C:\\hostedtoolcache\\node\\x64\\node.exe",
    baseEnv: { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", USERPROFILE: "C:\\Users\\runner", HOMEPATH: "\\Users\\runner", USERNAME: "runner", NODE_OPTIONS: "--x", HTTPS_PROXY: "http://proxy:3128" },
  });
  assert.equal(env.USERNAME, "runner");
  assert.equal(env.PATH, "C:\\hostedtoolcache\\node\\x64;C:\\Windows\\System32;C:\\Windows");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.NODE_OPTIONS, undefined);
  // Set here so libuv never copies the runner's home in.
  assert.equal(env.HOMEDRIVE, "D:");
  assert.equal(env.HOMEPATH, "\\a\\_temp\\d1-wrangler\\.isolation\\home");
  assert.equal(`${env.HOMEDRIVE}${env.HOMEPATH}`, env.USERPROFILE);
  for (const name of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOME"]) {
    assert.ok(path.win32.relative(target, env[name]).split("\\")[0] === ".isolation", name);
  }
  assert.deepEqual(Object.keys(env).filter((name) => !ALLOWED_ENV.has(name)), []);
});

test("the composite action exposes the three outputs and no install knobs", () => {
  const action = readFileSync(path.join(here, "action.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.match(action, /^runs:\n  using: composite$/m);
  assert.match(action, /run: node "\$GITHUB_ACTION_PATH\/wrangler-pinned\.mjs"/);
  assert.match(action, /INPUT_DIR: \$\{\{ inputs\.dir \}\}/);
  for (const output of ["wrangler-bin", "wrangler-dir", "wrangler-version"]) {
    assert.match(action, new RegExp(`^  ${output}:\\n    description: .+\\n    value: \\$\\{\\{ steps\\.install\\.outputs\\['${output}'\\] \\}\\}$`, "m"));
  }
  const inputs = action.match(/^inputs:\n([\s\S]*?)^\S/m)[1];
  assert.deepEqual([...inputs.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]), ["dir"]);
  assert.doesNotMatch(action, /secrets\.|token|registry-url|pnpm-version/i);
});
