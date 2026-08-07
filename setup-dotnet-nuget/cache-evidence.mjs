#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isDirectExecution, resolveInside } from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const EXCLUDED_DIRECTORIES = new Set([".git", "bin", "node_modules", "obj"]);
const MAX_LOCK_FILES = 1024;

async function hasEntries(directory) {
  try {
    const entries = await readdir(directory);
    return entries.length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function collectLockFiles(root, current = root, result = []) {
  if (result.length > MAX_LOCK_FILES) throw new Error(`packages.lock.json count exceeds ${MAX_LOCK_FILES}`);
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) await collectLockFiles(root, entryPath, result);
    else if (entry.isFile() && entry.name === "packages.lock.json") result.push(entryPath);
  }
  return result;
}

export async function resolveNugetCacheEvidence({
  workspace,
  restorePath = ".",
  packagesPath,
  httpCachePath,
  sdkVersion,
}) {
  const target = restorePath === "." ? workspace : resolveInside(workspace, restorePath, "restore-path");
  let root = target;
  try {
    if ((await stat(target)).isFile()) root = path.dirname(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lockFiles = (await collectLockFiles(root)).sort((left, right) => left.localeCompare(right));
  const lockDigest = createHash("sha256");
  if (lockFiles.length === 0) {
    lockDigest.update("packages-lock-unavailable", "utf8");
  } else {
    for (const lockFile of lockFiles) {
      lockDigest.update(path.relative(workspace, lockFile).replaceAll(path.sep, "/"), "utf8");
      lockDigest.update("\0");
      lockDigest.update(await readFile(lockFile));
      lockDigest.update("\0");
    }
  }
  const lockHash = lockDigest.digest("hex");
  const packagesWarm = await hasEntries(packagesPath);
  const httpWarm = await hasEntries(httpCachePath);
  const cacheClass = packagesWarm || httpWarm ? "warm" : "cold";
  const cacheKeyHash = createHash("sha256")
    .update(`nuget-persistent\0${sdkVersion}\0${lockHash}`)
    .digest("hex");
  return { cacheClass, cacheKeyHash, lockHash, lockFileCount: lockFiles.length, packagesWarm, httpWarm };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("invalid argument sequence");
    args.set(name.slice(2), value);
  }
  const result = await resolveNugetCacheEvidence({
    workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
    restorePath: args.get("restore-path") || ".",
    packagesPath: args.get("packages-path"),
    httpCachePath: args.get("http-cache-path"),
    sdkVersion: args.get("sdk-version"),
  });
  await writeOutputs(args.get("github-output"), {
    "cache-class": result.cacheClass,
    "cache-key-hash": result.cacheKeyHash,
    "lock-hash": result.lockHash,
    "lock-file-count": result.lockFileCount,
    "telemetry-status": "not_requested",
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`setup-dotnet-nuget cache evidence: ${error.message}\n`);
    process.exitCode = 1;
  });
}
