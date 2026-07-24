#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPlainObject,
  isDirectExecution,
  normalizeIso,
  parseBoundedJson,
  parseNonNegativeInteger,
  redactBounded,
  resolveInside,
  sha256,
  stableStringify,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function walkFiles(root, current, excluded, files, seenPaths, maximum) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (excluded.has(relative)) continue;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`release root contains a symbolic link: ${relative}`);
    if (info.isDirectory()) {
      await walkFiles(root, absolute, excluded, files, seenPaths, maximum);
      continue;
    }
    if (!info.isFile()) throw new Error(`release root contains an unsupported entry: ${relative}`);
    if (Buffer.byteLength(relative, "utf8") > 512) throw new Error(`release path exceeds 512 bytes: ${relative}`);
    if (/[\u0000-\u001f\u007f]/.test(relative)) throw new Error(`release path contains control characters: ${relative}`);
    const portablePath = relative.toLowerCase();
    if (seenPaths.has(portablePath)) throw new Error(`release contains a case-insensitive path collision: ${relative}`);
    seenPaths.add(portablePath);
    files.push({ path: relative, ...(await hashFile(absolute)) });
    if (files.length > maximum) throw new Error(`release exceeds max-files (${maximum})`);
  }
}

function safeRoot(workspace, input) {
  const value = input?.trim() || ".";
  if (value === ".") return path.resolve(workspace);
  return resolveInside(workspace, value, "root");
}

export async function createReleaseManifest({
  workspace,
  root = ".",
  outputPath = "release-manifest.json",
  artifactName,
  releaseSha,
  metadataJson = "{}",
  createdAt = new Date().toISOString(),
  maxFiles = 20000,
  repository = null,
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(artifactName ?? "")) {
    throw new Error("artifact-name must be a bounded identifier");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(releaseSha ?? "")) {
    throw new Error("release-sha must be a 40- or 64-character hexadecimal digest");
  }
  const maximum = parseNonNegativeInteger(maxFiles, "max-files", 100000);
  if (maximum < 1) throw new Error("max-files must be at least 1");
  const absoluteRoot = safeRoot(workspace, root);
  const info = await lstat(absoluteRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("root must be a real directory");
  const manifestPath = resolveInside(absoluteRoot, outputPath, "output-path");
  const relativeManifest = path.relative(absoluteRoot, manifestPath).replaceAll("\\", "/");
  const hashPath = `${manifestPath}.sha256`;
  const relativeHash = path.relative(absoluteRoot, hashPath).replaceAll("\\", "/");

  const metadataInput = assertPlainObject(
    parseBoundedJson(metadataJson, { label: "metadata-json", maxBytes: 8192 }),
    "metadata-json",
  );
  const { value: metadata, redactedFields } = redactBounded(metadataInput, {
    maxDepth: 3,
    maxKeys: 32,
    maxStringBytes: 512,
  });
  const files = [];
  await walkFiles(
    absoluteRoot,
    absoluteRoot,
    new Set([relativeManifest, relativeHash]),
    files,
    new Set(),
    maximum,
  );
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const manifest = {
    schema_id: "https://schemas.cloudingenium.com/ci-actions/release-manifest/v1",
    schema_version: 1,
    artifact_name: artifactName,
    repository,
    release_sha: releaseSha.toLowerCase(),
    created_at: normalizeIso(createdAt, "created-at"),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    metadata,
    redacted_field_count: redactedFields,
  };
  const serialized = stableStringify(manifest);
  if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
    throw new Error("release manifest exceeds 8 MiB");
  }
  const manifestHash = sha256(serialized);
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, manifestPath);
  await writeFile(hashPath, `${manifestHash}  ${path.basename(manifestPath)}\n`, {
    encoding: "ascii",
    mode: 0o600,
  });
  return { manifest, manifestPath, hashPath, manifestHash };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument sequence near ${argv[index] ?? "<end>"}`);
    }
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const result = await createReleaseManifest({
    workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
    root: args.get("root"),
    outputPath: args.get("output-path"),
    artifactName: args.get("artifact-name"),
    releaseSha: args.get("release-sha"),
    metadataJson: args.get("metadata-json"),
    createdAt: args.get("created-at") || new Date().toISOString(),
    maxFiles: args.get("max-files") || "20000",
    repository: process.env.GITHUB_REPOSITORY || null,
  });
  await writeOutputs(args.get("github-output"), {
    "manifest-path": result.manifestPath,
    "manifest-sha256-path": result.hashPath,
    "manifest-sha256": result.manifestHash,
    "file-count": result.manifest.file_count,
    "total-bytes": result.manifest.total_bytes,
    "redacted-field-count": result.manifest.redacted_field_count,
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  });
}
