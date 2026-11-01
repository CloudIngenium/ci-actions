import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tmpFixture } from "../lib/tmp-fixture.mjs";

const script = fileURLToPath(new URL("./select-store.sh", import.meta.url));
const action = fileURLToPath(new URL("./action.yml", import.meta.url));
const bash = process.platform === "win32"
  ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "bash";
// The hosts that declare a shared store are Linux (k3s agents, CI-SP-01); a Windows temp path is
// not a POSIX absolute path, so the host-shared cases only run where they can be true.
const posixOnly = { skip: process.platform === "win32" ? "host stores are Linux-only" : false };

// Runs the selector with only the given store variables set, never the caller's own.
function run(args, env = {}) {
  const base = { ...process.env };
  delete base.PNPM_STORE_DIR;
  delete base.pnpm_config_store_dir;
  return spawnSync(bash, [script, ...args], { env: { ...base, ...env }, encoding: "utf8" });
}

function select(prefix, env = {}) {
  const result = run([prefix], env);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.replace(/\n$/, "");
  const space = line.indexOf(" ");
  return { kind: line.slice(0, space), dir: line.slice(space + 1), stderr: result.stderr };
}

const pick = ({ kind, dir }) => ({ kind, dir });

test("no host store: the per-job store under the pnpm prefix, with no warning", () => {
  const prefix = tmpFixture("select-store-prefix");
  const chosen = select(prefix);
  assert.deepEqual(pick(chosen), { kind: "isolated", dir: `${prefix}/store` });
  assert.equal(chosen.stderr, "");
});

test("no prefix argument fails, so the action step fails instead of using no store", () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: select-store\.sh/);
});

test("a k3s agent's PNPM_STORE_DIR (D374) is used when it is a runner-owned 0755 directory", posixOnly, () => {
  const prefix = tmpFixture("select-store-prefix");
  const shared = tmpFixture("select-store-shared");
  chmodSync(shared, 0o755);
  const chosen = select(prefix, { PNPM_STORE_DIR: shared });
  assert.deepEqual(pick(chosen), { kind: "host-shared", dir: shared });
  assert.equal(chosen.stderr, "");
});

test("CI-SP-01's pnpm_config_store_dir (D375) is used, and PNPM_STORE_DIR wins when both are set", posixOnly, () => {
  const prefix = tmpFixture("select-store-prefix");
  const panama = tmpFixture("select-store-panama");
  const k3s = tmpFixture("select-store-k3s");
  chmodSync(panama, 0o755);
  chmodSync(k3s, 0o755);
  assert.deepEqual(pick(select(prefix, { pnpm_config_store_dir: panama })), { kind: "host-shared", dir: panama });
  assert.deepEqual(
    pick(select(prefix, { PNPM_STORE_DIR: k3s, pnpm_config_store_dir: panama })),
    { kind: "host-shared", dir: k3s },
  );
});

test("a path with a space survives the selector's output", posixOnly, () => {
  const prefix = tmpFixture("select-store-prefix");
  const dir = path.join(tmpFixture("select-store-space"), "pnpm store");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  assert.deepEqual(pick(select(prefix, { PNPM_STORE_DIR: dir })), { kind: "host-shared", dir });
});

test("a declared store that is missing, relative or not writable falls back to the per-job store, with a warning", posixOnly, () => {
  const prefix = tmpFixture("select-store-prefix");
  const root = tmpFixture("select-store-bad");
  const isolated = { kind: "isolated", dir: `${prefix}/store` };
  const missing = select(prefix, { PNPM_STORE_DIR: path.join(root, "absent") });
  assert.deepEqual(pick(missing), isolated);
  assert.match(missing.stderr, /^::warning title=pnpm store::PNPM_STORE_DIR=.*absent ignored \(missing or not a directory\)/m);
  const relative = select(prefix, { PNPM_STORE_DIR: "relative/store" });
  assert.deepEqual(pick(relative), isolated);
  assert.match(relative.stderr, /ignored \(not an absolute path\)/);
  if (process.getuid?.() !== 0) {
    const readOnly = path.join(root, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    const ro = select(prefix, { pnpm_config_store_dir: readOnly });
    assert.deepEqual(pick(ro), isolated);
    assert.match(ro.stderr, /pnpm_config_store_dir=.* ignored \(not writable\)/);
  }
});

test("a declared store that the group or anyone else can write is refused (another account could poison it)", posixOnly, () => {
  const prefix = tmpFixture("select-store-prefix");
  const root = tmpFixture("select-store-perm");
  for (const [name, mode] of [["world", 0o777], ["group", 0o775]]) {
    const dir = path.join(root, name);
    mkdirSync(dir);
    chmodSync(dir, mode);
    const chosen = select(prefix, { PNPM_STORE_DIR: dir });
    assert.deepEqual(pick(chosen), { kind: "isolated", dir: `${prefix}/store` }, name);
    assert.match(chosen.stderr, /ignored \(group or world writable\)/, name);
  }
});

test("a refused PNPM_STORE_DIR still lets a usable pnpm_config_store_dir through", posixOnly, () => {
  const prefix = tmpFixture("select-store-prefix");
  const panama = tmpFixture("select-store-panama");
  chmodSync(panama, 0o755);
  const chosen = select(prefix, { PNPM_STORE_DIR: "relative", pnpm_config_store_dir: panama });
  assert.deepEqual(pick(chosen), { kind: "host-shared", dir: panama });
  assert.match(chosen.stderr, /PNPM_STORE_DIR=relative ignored/);
});

test("the action reads the selector the way it is parsed here and points pnpm at the selected store", posixOnly, () => {
  const source = readFileSync(action, "utf8");
  assert.match(source, /read -r store_kind store < <\(bash "\$GITHUB_ACTION_PATH\/select-store\.sh" "\$pnpm_root"\)/);
  assert.match(source, /echo "PNPM_CONFIG_STORE_DIR=\$store"/);
  assert.match(source, /echo "NPM_CONFIG_STORE_DIR=\$store"/);
  assert.doesNotMatch(source, /PNPM_CONFIG_STORE_DIR=\$pnpm_root\/store/);
  assert.match(source, /STORE_KIND: \$\{\{ steps\.install_pnpm\.outputs\['store-kind'\] \}\}/);
  // The same read, under the step's shell options, on a path with a space.
  const dir = path.join(tmpFixture("select-store-read"), "a b");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const probe = spawnSync(bash, ["-c", `set -euo pipefail; read -r store_kind store < <(bash "$1" /tmp/prefix); printf '%s|%s' "$store_kind" "$store"`, "probe", script], {
    env: { ...process.env, PNPM_STORE_DIR: dir, pnpm_config_store_dir: "" },
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, `host-shared|${dir}`);
  // A selector that fails (no output) fails the step: `read` hits end of input under set -e.
  const failing = spawnSync(bash, ["-c", `set -euo pipefail; read -r store_kind store < <(bash "$1"); echo reached`, "probe", script], { encoding: "utf8" });
  assert.notEqual(failing.status, 0);
  assert.doesNotMatch(failing.stdout, /reached/);
});
