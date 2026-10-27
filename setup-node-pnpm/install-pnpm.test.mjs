import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tmpFixture } from "../lib/tmp-fixture.mjs";

const script = fileURLToPath(new URL("./install-pnpm.sh", import.meta.url));
const bash = process.platform === "win32"
  ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "bash";

// A stand-in for npm: each call takes the next outcome from STUB_PLAN and logs it, so a test reads
// how many installs ran and whether each one found the prefix empty.
//   ok    installs a bin/pnpm that prints the version
//   segv  installs a bin/pnpm that exits 139, as pnpm 12's stub does without its platform binary
//   fail  exits 1 without installing, as npm does when the registry refuses the connection
const STUB_NPM = `#!/usr/bin/env bash
set -euo pipefail
prefix="$4"
n=1
[ -f "$STUB_LOG" ] && n=$(( $(wc -l < "$STUB_LOG") + 1 ))
outcome=$(echo "$STUB_PLAN" | cut -d, -f"$n")
leftover=clean
[ -e "$prefix/marker" ] && leftover=dirty
echo "$outcome $leftover" >> "$STUB_LOG"
[ "$outcome" = fail ] && exit 1
mkdir -p "$prefix/bin"
touch "$prefix/marker"
if [ "$outcome" = ok ]; then
  printf '#!/usr/bin/env bash\\necho 12.15.0\\n' > "$prefix/bin/pnpm"
else
  printf '#!/usr/bin/env bash\\nexit 139\\n' > "$prefix/bin/pnpm"
fi
chmod +x "$prefix/bin/pnpm"
`;

function run(plan, env = {}) {
  const root = tmpFixture("ci-actions-install-pnpm");
  const npm = path.join(root, "npm-stub");
  const log = path.join(root, "npm.log");
  writeFileSync(npm, STUB_NPM);
  chmodSync(npm, 0o755);
  const result = spawnSync(bash, [script, path.join(root, "prefix")], {
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_registry: "",
      NPM_CONFIG_REGISTRY: "",
      PNPM_VERSION: "12.15.0",
      PNPM_INSTALL_NPM: npm,
      PNPM_INSTALL_RETRY_DELAY: "0",
      STUB_PLAN: plan,
      STUB_LOG: log,
      ...env,
    },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    // no npm call ran
  }
  return { ...result, calls };
}

test("a clean install prints the version after one npm call", () => {
  const { status, stdout, calls } = run("ok");
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "12.15.0");
  assert.deepEqual(calls, ["ok clean"]);
});

test("a segfaulting stub is reinstalled into an empty prefix", () => {
  const { status, stdout, calls } = run("segv,ok");
  assert.equal(status, 0);
  assert.match(stdout, /::warning::pnpm 12\.15\.0 install attempt 1 of 3 failed \(pnpm --version exited 139, its optional platform binary did not install\)/);
  assert.match(stdout, /12\.15\.0\s*$/);
  assert.deepEqual(calls, ["segv clean", "ok clean"]);
});

test("a refused registry fails after the last attempt and names the registry", () => {
  const { status, stdout, calls } = run("fail,fail,fail", { npm_config_registry: "http://cache.example:4873/" });
  assert.equal(status, 1);
  assert.equal((stdout.match(/::warning::/g) ?? []).length, 2);
  assert.match(stdout, /::error::pnpm 12\.15\.0 did not install after 3 attempts \(npm install exited 1\)\. Registry: http:\/\/cache\.example:4873\//);
  assert.deepEqual(calls, ["fail clean", "fail clean", "fail clean"]);
});

test("PNPM_INSTALL_ATTEMPTS bounds the loop", () => {
  const { status, calls } = run("segv,segv,ok", { PNPM_INSTALL_ATTEMPTS: "2" });
  assert.equal(status, 1);
  assert.deepEqual(calls, ["segv clean", "segv clean"]);
});
