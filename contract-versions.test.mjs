import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const policy = "local-first-shadow-v4.6.9-r5";
const actionFiles = [
  "emit-cache-observation/action.yml",
  "emit-ci-phase/action.yml",
  "setup-ci-phase-emitter/action.yml",
  "setup-node-pnpm/action.yml",
  "setup-dotnet-nuget/action.yml",
];
const runtimeFiles = [
  "emit-cache-observation/emit-cache-observation.mjs",
  "emit-ci-phase/emit-ci-phase.mjs",
];

test("canonical emitters share the active policy version", () => {
  for (const file of [...actionFiles, ...runtimeFiles]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, new RegExp(policy.replaceAll(".", "\\.")), `${file} must use policy r5`);
    assert.doesNotMatch(source, /local-first-shadow-v4\.6\.6-r4/, `${file} must not emit the retired policy`);
  }
});

test("toolchain setup actions forward all version dimensions", () => {
  for (const file of ["setup-node-pnpm/action.yml", "setup-dotnet-nuget/action.yml"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /INPUT_FINGERPRINT_VERSION: \$\{\{ inputs\.fingerprint-version \}\}/);
    assert.match(source, /INPUT_POOL_MAPPING_VERSION: \$\{\{ inputs\.pool-mapping-version \}\}/);
    assert.match(source, /INPUT_POLICY_VERSION: \$\{\{ inputs\.policy-version \}\}/);
  }
});
