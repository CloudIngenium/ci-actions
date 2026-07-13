#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const EXACT_STABLE_SEMVER = /^\d+\.\d+\.\d+$/;

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument sequence near ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function validate(version, source) {
  if (!EXACT_STABLE_SEMVER.test(version)) {
    throw new Error(`${source} must select an exact stable pnpm semver, received ${JSON.stringify(version)}`);
  }
  return version;
}

export async function resolvePnpmVersion({ explicit = "", manifest, fallback }) {
  if (explicit) return validate(explicit, "pnpm-version");

  try {
    const packageJson = JSON.parse(await readFile(manifest, "utf8"));
    if (packageJson.packageManager !== undefined) {
      const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager);
      if (!match) {
        throw new Error(
          `packageManager in ${manifest} must be pnpm@<exact-stable-semver>, received ${JSON.stringify(packageJson.packageManager)}`,
        );
      }
      return match[1];
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return validate(fallback, "fallback");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = readArguments(process.argv.slice(2));
    const version = await resolvePnpmVersion({
      explicit: args.get("explicit") ?? "",
      manifest: args.get("manifest"),
      fallback: args.get("fallback"),
    });
    process.stdout.write(`${version}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  }
}
