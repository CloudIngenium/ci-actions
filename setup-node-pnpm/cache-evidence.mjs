#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isDirectExecution, resolveInside } from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

export async function resolveIsolatedPnpmCacheEvidence({ workspace, lockFile, nodeVersion, pnpmVersion }) {
  const lockPath = resolveInside(workspace, lockFile || "pnpm-lock.yaml", "lock-file");
  let lockBytes;
  try {
    lockBytes = await readFile(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    lockBytes = Buffer.from("lockfile-unavailable", "utf8");
  }
  const lockHash = createHash("sha256").update(lockBytes).digest("hex");
  const cacheKeyHash = createHash("sha256")
    .update(`pnpm-store\0${nodeVersion}\0${pnpmVersion}\0${lockHash}`)
    .digest("hex");
  return { lockHash, cacheKeyHash, cacheClass: "cold" };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("invalid argument sequence");
    args.set(name.slice(2), value);
  }
  const result = await resolveIsolatedPnpmCacheEvidence({
    workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
    lockFile: args.get("lock-file") || "pnpm-lock.yaml",
    nodeVersion: args.get("node-version"),
    pnpmVersion: args.get("pnpm-version"),
  });
  await writeOutputs(args.get("github-output"), {
    "lock-hash": result.lockHash,
    "cache-key-hash": result.cacheKeyHash,
    "cache-class": result.cacheClass,
    "telemetry-status": "not_requested",
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`setup-node-pnpm cache evidence: ${error.message}\n`);
    process.exitCode = 1;
  });
}
