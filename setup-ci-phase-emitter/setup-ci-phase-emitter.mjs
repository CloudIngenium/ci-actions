import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/i;
const POSITIVE_VERSION = /^[1-9][0-9]{0,5}$/;
const POLICY_VERSION = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const LANES = new Set([
  "",
  "gate-fast",
  "control-fast",
  "pr-fast",
  "admin-interactive",
  "admin-batch",
  "build-fast",
  "build-heavy",
  "background",
  "legacy-slow",
  "deploy",
  "mcp-build",
  "mcp-deploy",
  "windows-pr-fast",
  "windows-build-fast",
  "windows-background",
  "azure-burst",
  "github-hosted",
  "other",
]);

function requiredFile(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function appendCommand(file, key, value) {
  appendFileSync(requiredFile(file, key), `${key}=${value}\n`, "utf8");
}

export function resolveSetup(input, context = {}) {
  if (!SHA256.test(input.sourceManifestSha256 ?? "")) {
    throw new Error("source-manifest-sha256 must be 64 hexadecimal characters");
  }
  if (!POSITIVE_VERSION.test(input.fingerprintVersion ?? "") ||
      !POSITIVE_VERSION.test(input.poolMappingVersion ?? "")) {
    throw new Error("fingerprint and pool mapping versions must be positive integers");
  }
  if (!POLICY_VERSION.test(input.policyVersion ?? "")) {
    throw new Error("policy-version is invalid");
  }
  if (!LANES.has(input.selectedLane ?? "")) {
    throw new Error("selected-lane is invalid");
  }

  const actionPath = context.actionPath || path.dirname(fileURLToPath(import.meta.url));
  const emitterPath = path.resolve(actionPath, "../emit-ci-phase/emit-ci-phase.mjs");
  const nodePath = context.nodePath || process.execPath;
  if (!existsSync(emitterPath)) throw new Error(`Canonical CI phase emitter is missing: ${emitterPath}`);
  if (!existsSync(nodePath)) throw new Error(`Runner-managed Node executable is missing: ${nodePath}`);

  return {
    emitterPath,
    nodePath,
    nodeDirectory: path.dirname(nodePath),
    environment: {
      CI_PHASE_EMITTER: emitterPath,
      CI_NODE_EXECUTABLE: nodePath,
      CI_CONTROL_V4_MANIFEST_SHA256: input.sourceManifestSha256.toLowerCase(),
      CI_FINGERPRINT_VERSION: input.fingerprintVersion,
      CI_POOL_MAPPING_VERSION: input.poolMappingVersion,
      CI_POLICY_VERSION: input.policyVersion,
      CI_SELECTED_LANE: input.selectedLane ?? "",
    },
  };
}

export function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`];
  const setup = resolveSetup({
    sourceManifestSha256: input("source-manifest-sha256"),
    fingerprintVersion: input("fingerprint-version"),
    poolMappingVersion: input("pool-mapping-version"),
    policyVersion: input("policy-version"),
    selectedLane: input("selected-lane"),
  }, {
    actionPath: environment.GITHUB_ACTION_PATH,
    nodePath: process.execPath,
  });

  for (const [key, value] of Object.entries(setup.environment)) {
    appendCommand(environment.GITHUB_ENV, key, value);
  }
  appendFileSync(requiredFile(environment.GITHUB_PATH, "GITHUB_PATH"), `${setup.nodeDirectory}\n`, "utf8");
  appendCommand(environment.GITHUB_OUTPUT, "emitter-path", setup.emitterPath);
  appendCommand(environment.GITHUB_OUTPUT, "node-path", setup.nodePath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  }
}
