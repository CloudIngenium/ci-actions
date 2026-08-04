import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile as appendText, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const SIGNED_HOST_SUFFIXES = [
  ".actions.githubusercontent.com",
  ".githubusercontent.com",
  ".blob.core.windows.net",
];

function requireText(value, name, maxLength = 512) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return normalized;
}

function parseInputs(env = process.env) {
  const repository = requireText(env.INPUT_REPOSITORY, "repository", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("repository must be owner/name.");
  const runId = requireText(env.INPUT_RUN_ID, "run-id", 24);
  if (!/^[1-9][0-9]*$/u.test(runId)) throw new Error("run-id must be numeric.");
  const artifactName = requireText(env.INPUT_ARTIFACT_NAME, "artifact-name", 256);
  const destination = resolve(requireText(env.INPUT_DESTINATION, "destination", 1024));
  const token = requireText(env.INPUT_GITHUB_TOKEN, "github-token", 4096);
  const rangeCount = Number.parseInt(String(env.INPUT_RANGE_COUNT ?? "4"), 10);
  if (!Number.isInteger(rangeCount) || rangeCount < 2 || rangeCount > 8) throw new Error("range-count must be an integer from 2 through 8.");
  return { repository, runId, artifactName, destination, token, rangeCount };
}

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "cloudingenium-ci-actions-ranged-artifact",
  };
}

async function requireJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  return response.json();
}

function validateSignedUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !SIGNED_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) {
    throw new Error("GitHub returned an unexpected artifact download host.");
  }
  return url;
}

function parseDigest(value) {
  const match = /^sha256:([0-9a-f]{64})$/iu.exec(String(value ?? ""));
  if (!match) throw new Error("Artifact metadata is missing a supported sha256 digest.");
  return match[1].toLowerCase();
}

function parseContentRange(value) {
  const match = /^bytes 0-0\/([1-9][0-9]*)$/u.exec(String(value ?? ""));
  if (!match) throw new Error("Artifact server did not return a bounded Content-Range probe.");
  return Number.parseInt(match[1], 10);
}

function buildRanges(totalBytes, rangeCount) {
  const chunkSize = Math.ceil(totalBytes / rangeCount);
  const ranges = [];
  for (let index = 0; index < rangeCount; index += 1) {
    const start = index * chunkSize;
    if (start >= totalBytes) break;
    ranges.push({ index, start, end: Math.min(totalBytes - 1, start + chunkSize - 1) });
  }
  return ranges;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeResponseBody(response, path, expectedBytes) {
  if (response.status !== 206 || !response.body) throw new Error(`Artifact range request failed with HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: "wx" }));
  const actual = (await stat(path)).size;
  if (actual !== expectedBytes) throw new Error(`Artifact range length mismatch (${actual}/${expectedBytes}).`);
}

async function appendBinary(source, destinationHandle) {
  for await (const chunk of createReadStream(source)) await destinationHandle.write(chunk);
}

async function setOutput(name, value, env = process.env) {
  if (env.GITHUB_OUTPUT) await appendText(env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

export async function downloadArtifact(inputs, { fetchImpl = fetch, env = process.env } = {}) {
  const startedAt = Date.now();
  const encodedName = encodeURIComponent(inputs.artifactName);
  const metadataUrl = `https://api.github.com/repos/${inputs.repository}/actions/runs/${inputs.runId}/artifacts?name=${encodedName}&per_page=100`;
  const metadata = await requireJson(await fetchImpl(metadataUrl, { headers: apiHeaders(inputs.token) }), "Artifact lookup");
  const candidates = (metadata.artifacts ?? []).filter((artifact) => artifact.name === inputs.artifactName && !artifact.expired);
  if (candidates.length !== 1) throw new Error(`Expected one unexpired artifact named ${inputs.artifactName}; found ${candidates.length}.`);

  const artifact = candidates[0];
  const expectedDigest = parseDigest(artifact.digest);
  const downloadApi = `https://api.github.com/repos/${inputs.repository}/actions/artifacts/${artifact.id}/zip`;
  const redirect = await fetchImpl(downloadApi, { headers: apiHeaders(inputs.token), redirect: "manual" });
  if (![301, 302, 303, 307, 308].includes(redirect.status)) {
    throw new Error(`Artifact download did not return a signed redirect (HTTP ${redirect.status}).`);
  }
  const signedUrl = validateSignedUrl(redirect.headers.get("location"));

  const probe = await fetchImpl(signedUrl, { headers: { range: "bytes=0-0" } });
  if (probe.status !== 206) throw new Error(`Artifact server does not support stable byte ranges (HTTP ${probe.status}).`);
  const totalBytes = parseContentRange(probe.headers.get("content-range"));
  await probe.body?.cancel();
  if (Number.isFinite(Number(artifact.size_in_bytes)) && Number(artifact.size_in_bytes) !== totalBytes) {
    throw new Error(`Artifact API size disagrees with ranged archive size (${artifact.size_in_bytes}/${totalBytes}).`);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "cloudingenium-artifact-"));
  const archivePath = join(tempRoot, `${basename(inputs.artifactName).replace(/[^A-Za-z0-9_.-]/gu, "_")}.zip`);
  const ranges = buildRanges(totalBytes, inputs.rangeCount);
  try {
    const parts = await Promise.all(ranges.map(async (range) => {
      const response = await fetchImpl(signedUrl, { headers: { range: `bytes=${range.start}-${range.end}` } });
      const partPath = join(tempRoot, `part-${String(range.index).padStart(3, "0")}`);
      await writeResponseBody(response, partPath, range.end - range.start + 1);
      return partPath;
    }));

    const archive = await open(archivePath, "wx");
    try {
      for (const part of parts) await appendBinary(part, archive);
    } finally {
      await archive.close();
    }

    const actualDigest = await sha256File(archivePath);
    if (actualDigest !== expectedDigest) throw new Error("Artifact archive digest verification failed.");
    const durationMs = Date.now() - startedAt;
    await Promise.all([
      setOutput("artifact-id", artifact.id, env),
      setOutput("archive-path", archivePath, env),
      setOutput("archive-bytes", totalBytes, env),
      setOutput("digest", `sha256:${actualDigest}`, env),
      setOutput("duration-ms", durationMs, env),
      setOutput("range-count", ranges.length, env),
      setOutput("retry-count", 0, env),
    ]);
    console.log(`Verified artifact ${artifact.id}: ${totalBytes} bytes across ${ranges.length} ranges in ${durationMs} ms.`);
    return { artifactId: artifact.id, archivePath, totalBytes, digest: actualDigest, durationMs, rangeCount: ranges.length, retryCount: 0 };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await Promise.all(ranges.map((range) => rm(join(tempRoot, `part-${String(range.index).padStart(3, "0")}`), { force: true })));
  }
}

async function main() {
  await downloadArtifact(parseInputs());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`::error title=Ranged artifact download failed::${error.message}`);
    process.exitCode = 1;
  });
}

export { buildRanges, parseContentRange, parseDigest, parseInputs, validateSignedUrl };
