import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main, resolveSetup } from "./setup-ci-phase-emitter.mjs";

const validInput = {
  sourceManifestSha256: "a".repeat(64),
  fingerprintVersion: "10",
  poolMappingVersion: "11",
  policyVersion: "local-first-shadow-v4.6.6-r4",
  selectedLane: "deploy",
};

test("exports the runner-managed Node runtime with the canonical emitter", () => {
  const setup = resolveSetup(validInput);
  assert.equal(setup.nodePath, process.execPath);
  assert.equal(setup.nodeDirectory, path.dirname(process.execPath));
  assert.match(setup.emitterPath, /emit-ci-phase[\\/]emit-ci-phase\.mjs$/u);
  assert.equal(setup.environment.CI_NODE_EXECUTABLE, process.execPath);
  assert.equal(setup.environment.CI_PHASE_EMITTER, setup.emitterPath);
});

test("writes bounded environment, output, and PATH command files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-phase-setup-"));
  const environment = {
    "INPUT_SOURCE-MANIFEST-SHA256": validInput.sourceManifestSha256,
    "INPUT_FINGERPRINT-VERSION": validInput.fingerprintVersion,
    "INPUT_POOL-MAPPING-VERSION": validInput.poolMappingVersion,
    "INPUT_POLICY-VERSION": validInput.policyVersion,
    "INPUT_SELECTED-LANE": validInput.selectedLane,
    GITHUB_ACTION_PATH: path.dirname(new URL(import.meta.url).pathname),
    GITHUB_ENV: path.join(root, "env"),
    GITHUB_OUTPUT: path.join(root, "output"),
    GITHUB_PATH: path.join(root, "path"),
  };
  main(environment);
  assert.match(readFileSync(environment.GITHUB_ENV, "utf8"), /CI_NODE_EXECUTABLE=/u);
  assert.match(readFileSync(environment.GITHUB_OUTPUT, "utf8"), /node-path=/u);
  assert.equal(readFileSync(environment.GITHUB_PATH, "utf8").trim(), path.dirname(process.execPath));
});

test("rejects command-file injection and noncanonical versions", () => {
  assert.throws(() => resolveSetup({ ...validInput, selectedLane: "deploy\nBAD=value" }), /selected-lane/u);
  assert.throws(() => resolveSetup({ ...validInput, policyVersion: "bad\nvalue" }), /policy-version/u);
  assert.throws(() => resolveSetup({ ...validInput, fingerprintVersion: "0" }), /versions/u);
});
