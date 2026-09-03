#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPlainObject,
  isDirectExecution,
  normalizeIso,
  parseBoundedJson,
  resolveInside,
  stableStringify,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_NAMES = Object.freeze(["registry", "artifact", "sbom", "attestation", "canary"]);
const ECOSYSTEMS = new Set(["npm", "nuget", "python"]);
const MATURITY = new Set(["stable", "incubating", "deprecated"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value, location = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${location}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${location}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error(`undefined value at ${location}.${key}`);
      return [key, canonicalValue(value[key], `${location}.${key}`)];
    }));
  }
  throw new Error(`unsupported canonical JSON value at ${location}`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Canonical(value) {
  return sha256(canonicalJson(value));
}

function sortedUniqueStrings(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)
    || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
  if (sorted.length !== values.length) throw new Error(`${label} must not contain duplicates`);
  return sorted;
}

function packageMetadata(pkg) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)
    || typeof pkg.name !== "string" || pkg.name.length === 0
    || typeof pkg.version !== "string" || pkg.version.length === 0
    || !ECOSYSTEMS.has(pkg.ecosystem)
    || typeof pkg.owner !== "string" || pkg.owner.length === 0
    || !MATURITY.has(pkg.maturity)
    || !pkg.compatibility || typeof pkg.compatibility !== "object" || Array.isArray(pkg.compatibility)) {
    throw new Error("package-source package metadata is invalid");
  }
  const normalized = {
    name: pkg.name,
    version: pkg.version,
    ecosystem: pkg.ecosystem,
    owner: pkg.owner,
    maturity: pkg.maturity,
    compatibility: structuredClone(pkg.compatibility),
    checks: sortedUniqueStrings(pkg.checks, `${pkg.name}.checks`),
    expectedConsumers: sortedUniqueStrings(pkg.expectedConsumers, `${pkg.name}.expectedConsumers`),
    ...(pkg.architectureException ? { architectureException: pkg.architectureException } : {}),
    ...(pkg.retirementDate ? { retirementDate: pkg.retirementDate } : {}),
    extensions: structuredClone(pkg.extensions ?? {}),
  };
  if (normalized.maturity === "stable"
    && normalized.expectedConsumers.length < 2 && !normalized.architectureException) {
    throw new Error(`${pkg.name} requires two consumers or an architecture exception`);
  }
  if (normalized.maturity === "deprecated" && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.retirementDate ?? "")) {
    throw new Error(`${pkg.name} requires a retirement date`);
  }
  return normalized;
}

function selectedPackages(catalog, packageNames) {
  if (!Array.isArray(catalog.packages) || catalog.packages.length === 0) {
    throw new Error("package-source catalog packages are required");
  }
  const packages = new Map();
  for (const pkg of catalog.packages.map(packageMetadata)) {
    if (packages.has(pkg.name)) throw new Error(`duplicate package-source package: ${pkg.name}`);
    packages.set(pkg.name, pkg);
  }
  const selected = sortedUniqueStrings(packageNames, "package-names-json", { allowEmpty: false });
  const missing = selected.filter((name) => !packages.has(name));
  if (missing.length) throw new Error(`unknown package-source packages: ${missing.join(", ")}`);
  return selected.map((name) => packages.get(name)).sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function normalizedEvidence(value) {
  const evidence = assertPlainObject(value, "release-evidence");
  const unknown = Object.keys(evidence).filter((name) => !EVIDENCE_NAMES.includes(name));
  if (unknown.length) throw new Error(`unknown release evidence: ${unknown.join(", ")}`);
  return Object.fromEntries(EVIDENCE_NAMES.map((name) => {
    const descriptor = evidence[name];
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
      || descriptor.status !== "verified" || !SHA256.test(descriptor.digest ?? "")
      || (descriptor.uri !== undefined && (typeof descriptor.uri !== "string" || !URL.canParse(descriptor.uri)))
      || (descriptor.mediaType !== undefined && (typeof descriptor.mediaType !== "string" || descriptor.mediaType.length === 0))) {
      throw new Error(`${name} release evidence must be verified with a SHA-256 digest`);
    }
    return [name, {
      status: "verified",
      digest: descriptor.digest,
      ...(descriptor.uri ? { uri: descriptor.uri } : {}),
      ...(descriptor.mediaType ? { mediaType: descriptor.mediaType } : {}),
      extensions: structuredClone(descriptor.extensions ?? {}),
    }];
  }));
}

export function createPackageSourceV2({
  catalog,
  packageNames,
  releaseEvidence,
  repository,
  sourceCommit,
  sourcePath,
  sourceBlobSha,
  workflowRunId,
  contentDigest,
  occurredAt,
}) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
    || typeof catalog.producer !== "string" || catalog.producer.length === 0
    || repository !== `CloudIngenium/${catalog.producer}`
    || !GIT_SHA.test(sourceCommit ?? "") || !GIT_SHA.test(sourceBlobSha ?? "")
    || !SHA256.test(contentDigest ?? "") || !/^\d+$/.test(String(workflowRunId ?? ""))) {
    throw new Error("package-source provenance is invalid");
  }
  if (typeof sourcePath !== "string" || sourcePath.startsWith("/")
    || sourcePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("source-path must stay within the producer repository");
  }
  const publishedAt = normalizeIso(catalog.publishedAt, "published-at");
  const timestamp = normalizeIso(occurredAt, "occurred-at");
  if (Date.parse(timestamp) < Date.parse(publishedAt)) throw new Error("package-source record predates publication");
  const packages = selectedPackages(catalog, packageNames);
  const evidence = normalizedEvidence(releaseEvidence);
  const payload = {
    publishedAt,
    sourceBlobSha,
    digestAlgorithm: "sha256",
    contentDigest,
    releaseEvidence: evidence,
    packages,
  };
  const identity = {
    schemaVersion: "cloudingenium.package-source/v2",
    producer: catalog.producer,
    occurredAt: timestamp,
    publishedAt,
    repository,
    commit: sourceCommit,
    path: sourcePath,
    workflowRunId: String(workflowRunId),
    sourceBlobSha,
    contentDigest,
    packages,
    releaseEvidence: evidence,
  };
  return {
    $schema: "https://schemas.cloudingenium.com/fleet-control-plane/package-source.v2.schema.json",
    schemaVersion: "cloudingenium.package-source/v2",
    recordId: sha256Canonical(identity),
    occurredAt: timestamp,
    producer: catalog.producer,
    correlationId: `package-source:${catalog.producer}:${contentDigest.slice(0, 32)}`,
    provenance: {
      repository,
      commit: sourceCommit,
      path: sourcePath,
      workflowRunId: String(workflowRunId),
      source: "github-actions",
    },
    coverage: {
      status: "complete",
      requiredSources: [...EVIDENCE_NAMES],
      observedSources: [...EVIDENCE_NAMES],
      missingSources: [],
    },
    freshness: { capturedAt: timestamp, status: "fresh", maxAgeSeconds: 86_400 },
    dataClassification: "p0",
    digest: { algorithm: "sha256", value: sha256Canonical(payload), scope: "artifact" },
    extensions: {
      writer: "native-v2",
      producerSdk: "CloudIngenium/ci-actions/package-source-v2",
      sourceCatalogSchema: catalog.schemaVersion ?? "unversioned",
    },
    ...payload,
  };
}

export async function buildPackageSourceV2({
  workspace,
  catalogPath,
  packageNamesJson,
  releaseEvidencePath,
  repository,
  sourceCommit,
  sourcePath,
  sourceBlobSha,
  workflowRunId,
  occurredAt = new Date().toISOString(),
  outputPath = "package-source.v2.json",
}) {
  const absoluteCatalog = resolveInside(workspace, catalogPath, "catalog-path");
  const absoluteEvidence = resolveInside(workspace, releaseEvidencePath, "release-evidence-path");
  const absoluteOutput = resolveInside(workspace, outputPath, "output-path");
  const sourceBytes = await readFile(absoluteCatalog);
  const contentDigest = sha256(sourceBytes);
  const record = createPackageSourceV2({
    catalog: JSON.parse(sourceBytes.toString("utf8")),
    packageNames: parseBoundedJson(packageNamesJson, { label: "package-names-json", maxBytes: 64 * 1024 }),
    releaseEvidence: JSON.parse(await readFile(absoluteEvidence, "utf8")),
    repository,
    sourceCommit,
    sourcePath,
    sourceBlobSha,
    workflowRunId,
    contentDigest,
    occurredAt,
  });
  const serialized = stableStringify(record);
  const temporary = `${absoluteOutput}.${process.pid}.tmp`;
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, absoluteOutput);
  return {
    record,
    recordPath: absoluteOutput,
    recordDigest: sha256(serialized),
    contentDigest,
    packageVersionsJson: canonicalJson(Object.fromEntries(record.packages.map((pkg) => [pkg.name, pkg.version]))),
  };
}

export function actionInput(env, name, fallback = "") {
  return env[`INPUT_${name.toUpperCase().replaceAll(" ", "_")}`]?.trim() || fallback;
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const result = await buildPackageSourceV2({
    workspace,
    catalogPath: actionInput(process.env, "catalog-path"),
    packageNamesJson: actionInput(process.env, "package-names-json"),
    releaseEvidencePath: actionInput(process.env, "release-evidence-path"),
    repository: actionInput(process.env, "repository", process.env.GITHUB_REPOSITORY),
    sourceCommit: actionInput(process.env, "source-commit", process.env.GITHUB_SHA),
    sourcePath: actionInput(process.env, "source-path"),
    sourceBlobSha: actionInput(process.env, "source-blob-sha"),
    workflowRunId: actionInput(process.env, "workflow-run-id", process.env.GITHUB_RUN_ID),
    occurredAt: actionInput(process.env, "occurred-at", new Date().toISOString()),
    outputPath: actionInput(process.env, "output-path", ".package-source/package-source.v2.json"),
  });
  await writeOutputs(process.env.GITHUB_OUTPUT, {
    "record-path": result.recordPath,
    "record-id": result.record.recordId,
    "record-sha256": result.recordDigest,
    "content-sha256": result.contentDigest,
    "package-versions-json": result.packageVersionsJson,
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  });
}
