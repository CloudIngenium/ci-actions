import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadArtifact, parseInputs, validateSignedUrl } from "./download-ranged-artifact.mjs";

function fixtureFetch(archive, { digest = createHash("sha256").update(archive).digest("hex"), rangeStatus = 206 } = {}) {
  const signed = "https://results-receiver.actions.githubusercontent.com/artifact.zip?sig=hidden";
  return async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/actions/runs/123/artifacts?")) {
      return Response.json({ artifacts: [{ id: 456, name: "release", expired: false, size_in_bytes: archive.length, digest: `sha256:${digest}` }] });
    }
    if (target.endsWith("/actions/artifacts/456/zip")) return new Response(null, { status: 302, headers: { location: signed } });
    assert.equal(target, signed);
    const match = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = archive.subarray(start, end + 1);
    const contentRange = start === 0 && end === 0 ? `bytes 0-0/${archive.length}` : `bytes ${start}-${end}/${archive.length}`;
    return new Response(body, { status: rangeStatus, headers: { "content-range": contentRange } });
  };
}

test("downloads four ranges and verifies the official digest", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "ranged-action-test-"));
  const outputFile = join(outputRoot, "github-output.txt");
  const archive = Buffer.from("cloudingenium-release-archive-fixture".repeat(257));
  try {
    const result = await downloadArtifact({ repository: "CloudIngenium/Zap", runId: "123", artifactName: "release", destination: outputRoot, token: "test-token", rangeCount: 4 }, { fetchImpl: fixtureFetch(archive), env: { GITHUB_OUTPUT: outputFile } });
    assert.equal(result.rangeCount, 4);
    assert.equal(result.retryCount, 0);
    assert.deepEqual(await readFile(result.archivePath), archive);
    assert.match(await readFile(outputFile, "utf8"), /retry-count=0/u);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("fails closed when the artifact digest disagrees", async () => {
  const archive = Buffer.from("archive");
  await assert.rejects(() => downloadArtifact({ repository: "CloudIngenium/Zap", runId: "123", artifactName: "release", destination: tmpdir(), token: "test-token", rangeCount: 4 }, { fetchImpl: fixtureFetch(archive, { digest: "0".repeat(64) }), env: {} }), /digest verification failed/u);
});

test("fails closed when the signed endpoint does not honor ranges", async () => {
  const archive = Buffer.from("archive");
  await assert.rejects(() => downloadArtifact({ repository: "CloudIngenium/Zap", runId: "123", artifactName: "release", destination: tmpdir(), token: "test-token", rangeCount: 4 }, { fetchImpl: fixtureFetch(archive, { rangeStatus: 200 }), env: {} }), /does not support stable byte ranges/u);
});

test("validates bounded inputs and signed hosts", () => {
  assert.throws(() => parseInputs({ INPUT_REPOSITORY: "owner/repo", INPUT_RUN_ID: "1", INPUT_ARTIFACT_NAME: "x", INPUT_DESTINATION: ".", INPUT_GITHUB_TOKEN: "x", INPUT_RANGE_COUNT: "9" }), /2 through 8/u);
  assert.throws(() => validateSignedUrl("https://example.com/archive.zip"), /unexpected artifact download host/u);
});

test("accepts GitHub's hyphenated JavaScript action inputs", () => {
  const inputs = parseInputs({
    INPUT_REPOSITORY: "owner/repo",
    "INPUT_RUN-ID": "123",
    "INPUT_ARTIFACT-NAME": "release",
    INPUT_DESTINATION: ".",
    "INPUT_GITHUB-TOKEN": "token",
    "INPUT_RANGE-COUNT": "4",
  });
  assert.equal(inputs.runId, "123");
  assert.equal(inputs.artifactName, "release");
  assert.equal(inputs.rangeCount, 4);
});

test("declares the runner-provided Node 24 action runtime", async () => {
  const metadata = await readFile(new URL("./action.yml", import.meta.url), "utf8");
  assert.match(metadata, /runs:\s*\n\s+using: node24\s*\n\s+main: download-ranged-artifact\.mjs/u);
  assert.doesNotMatch(metadata, /run:\s+node\b/u);
});
