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

// Runs the selector with only the given store variables set, never the caller's own.
function select(prefix, env = {}) {
  const base = { ...process.env };
  delete base.PNPM_STORE_DIR;
  delete base.pnpm_config_store_dir;
  const run = spawnSync(bash, [script, prefix], { env: { ...base, ...env }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [kind, dir] = run.stdout.trim().split(" ");
  return { kind, dir };
}

test("no host store: the per-job store under the pnpm prefix", () => {
  const prefix = tmpFixture("select-store-prefix");
  assert.deepEqual(select(prefix), { kind: "isolated", dir: `${prefix}/store` });
});

test("a k3s agent's PNPM_STORE_DIR (D374) is used when it is an existing writable directory", () => {
  const prefix = tmpFixture("select-store-prefix");
  const shared = tmpFixture("select-store-shared");
  assert.deepEqual(select(prefix, { PNPM_STORE_DIR: shared }), { kind: "host-shared", dir: shared });
});

test("CI-SP-01's pnpm_config_store_dir (D375) is used, and PNPM_STORE_DIR wins when both are set", () => {
  const prefix = tmpFixture("select-store-prefix");
  const panama = tmpFixture("select-store-panama");
  const k3s = tmpFixture("select-store-k3s");
  assert.deepEqual(select(prefix, { pnpm_config_store_dir: panama }), { kind: "host-shared", dir: panama });
  assert.deepEqual(
    select(prefix, { PNPM_STORE_DIR: k3s, pnpm_config_store_dir: panama }),
    { kind: "host-shared", dir: k3s },
  );
});

test("a declared store that is missing, relative or not writable falls back to the per-job store", () => {
  const prefix = tmpFixture("select-store-prefix");
  const root = tmpFixture("select-store-bad");
  const missing = path.join(root, "absent");
  assert.deepEqual(select(prefix, { PNPM_STORE_DIR: missing }), { kind: "isolated", dir: `${prefix}/store` });
  assert.deepEqual(select(prefix, { PNPM_STORE_DIR: "relative/store" }), { kind: "isolated", dir: `${prefix}/store` });
  if (process.getuid?.() !== 0 && process.platform !== "win32") {
    const readOnly = path.join(root, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    assert.deepEqual(select(prefix, { pnpm_config_store_dir: readOnly }), { kind: "isolated", dir: `${prefix}/store` });
  }
});

test("the action points pnpm at the selected store and reports a shared one as unknown", () => {
  const source = readFileSync(action, "utf8");
  assert.match(source, /select-store\.sh" "\$pnpm_root"/);
  assert.match(source, /echo "PNPM_CONFIG_STORE_DIR=\$store"/);
  assert.match(source, /echo "NPM_CONFIG_STORE_DIR=\$store"/);
  assert.doesNotMatch(source, /PNPM_CONFIG_STORE_DIR=\$pnpm_root\/store/);
  assert.match(source, /STORE_KIND: \$\{\{ steps\.install_pnpm\.outputs\['store-kind'\] \}\}/);
});
