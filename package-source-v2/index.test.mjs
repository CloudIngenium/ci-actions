import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { actionInput, buildPackageSourceV2, createPackageSourceV2 } from "./index.mjs";

const occurredAt = "2026-09-03T03:05:00.000Z";
const evidence = Object.fromEntries(["registry", "artifact", "sbom", "attestation", "canary"].map((name, index) => [
  name,
  {
    status: "verified",
    digest: String(index + 1).repeat(64),
    uri: `https://evidence.cloudingenium.com/${name}`,
    mediaType: "application/json",
    extensions: {},
  },
]));
const catalog = {
  schemaVersion: "cloudingenium.package-source/v1",
  producer: "astro-shared",
  publishedAt: "2026-09-03T03:00:00.000Z",
  packages: [{
    name: "@cloudingenium/ai",
    version: "5.0.6",
    ecosystem: "npm",
    owner: "platform",
    maturity: "stable",
    compatibility: { node: ">=24" },
    checks: ["tarball", "api-compatibility"],
    expectedConsumers: ["Tasks", "Knowledge-Hub"],
  }],
};

function create(overrides = {}) {
  return createPackageSourceV2({
    catalog,
    packageNames: ["@cloudingenium/ai"],
    releaseEvidence: evidence,
    repository: "CloudIngenium/astro-shared",
    sourceCommit: "a".repeat(40),
    sourcePath: "standards/generated/package-source.json",
    sourceBlobSha: "b".repeat(40),
    workflowRunId: "33710000000",
    contentDigest: "c".repeat(64),
    occurredAt,
    ...overrides,
  });
}

test("matches the control-plane native package-source identity vector", () => {
  const record = create();
  assert.equal(record.schemaVersion, "cloudingenium.package-source/v2");
  assert.equal(record.extensions.writer, "native-v2");
  assert.equal(record.recordId, "143885e11c8302d1ec7d9f2a7eb86b6e2bca505c3c567fdfaa05084a1541d272");
  assert.equal(record.digest.value, "a63ea2e7daff5903087b588876748812c109086ddaf7fdde116c14c3abce6170");
  assert.deepEqual(record.packages[0].expectedConsumers, ["Knowledge-Hub", "Tasks"]);
});

test("fails closed unless every release evidence class is verified", () => {
  const incomplete = structuredClone(evidence);
  incomplete.sbom.status = "missing";
  delete incomplete.sbom.digest;
  assert.throws(() => create({ releaseEvidence: incomplete }), /sbom release evidence must be verified/);
});

test("writes an atomic bounded record and exact package version map", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "package-source-v2-"));
  await mkdir(path.join(workspace, "standards"), { recursive: true });
  await writeFile(path.join(workspace, "standards/source.json"), `${JSON.stringify(catalog)}\n`);
  await writeFile(path.join(workspace, "evidence.json"), `${JSON.stringify(evidence)}\n`);
  const result = await buildPackageSourceV2({
    workspace,
    catalogPath: "standards/source.json",
    packageNamesJson: '["@cloudingenium/ai"]',
    releaseEvidencePath: "evidence.json",
    repository: "CloudIngenium/astro-shared",
    sourceCommit: "a".repeat(40),
    sourcePath: "standards/generated/package-source.json",
    sourceBlobSha: "b".repeat(40),
    workflowRunId: "33710000000",
    occurredAt,
    outputPath: "out/package-source.v2.json",
  });
  assert.equal(JSON.parse(await readFile(result.recordPath, "utf8")).recordId, result.record.recordId);
  assert.equal(result.recordDigest.length, 64);
  assert.equal(result.contentDigest.length, 64);
  assert.equal(result.packageVersionsJson, '{"@cloudingenium/ai":"5.0.6"}');
});

test("rejects cross-repository producers and traversal", async () => {
  assert.throws(() => create({ repository: "CloudIngenium/other" }), /provenance is invalid/);
  await assert.rejects(() => buildPackageSourceV2({
    workspace: process.cwd(),
    catalogPath: "../catalog.json",
  }), /must not be absolute or contain/);
});

test("reads GitHub's hyphenated JavaScript action input names", () => {
  assert.equal(actionInput({ "INPUT_PACKAGE-NAMES-JSON": '["a"]' }, "package-names-json"), '["a"]');
  assert.equal(actionInput({}, "repository", "CloudIngenium/fallback"), "CloudIngenium/fallback");
});
