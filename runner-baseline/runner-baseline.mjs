#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertPlainObject,
  isDirectExecution,
  parseBoolean,
  parseBoundedJson,
  resolveInside,
  sha256,
  stableStringify,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const EXACT_VERSION = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const EXACT_DOTNET_SDK = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function runVersion(command, args = []) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function firstVersion(value) {
  return value?.match(/\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

function compareVersions(left, right) {
  const leftParts = left.split(/[.+-]/).slice(0, 4).map(Number);
  const rightParts = right.split(/[.+-]/).slice(0, 4).map(Number);
  for (let index = 0; index < 4; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

function readBootId(platform) {
  if (platform === "linux") {
    try {
      return execFileSync("cat", ["/proc/sys/kernel/random/boot_id"], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
    } catch {
      return null;
    }
  }
  if (platform === "win32") {
    return runVersion("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
    ]);
  }
  return `${Math.floor(Date.now() / 1000 - os.uptime())}`;
}

function browserVersions() {
  const candidates = {
    chrome: process.platform === "win32"
      ? [["pwsh", ["-NoProfile", "-Command", "(Get-Item \"$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe\" -ErrorAction SilentlyContinue).VersionInfo.ProductVersion"]]]
      : [["google-chrome", ["--version"]], ["chromium", ["--version"]], ["chromium-browser", ["--version"]]],
    edge: process.platform === "win32"
      ? [["pwsh", ["-NoProfile", "-Command", "(Get-Item (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe') -ErrorAction SilentlyContinue).VersionInfo.ProductVersion"]]]
      : [["microsoft-edge", ["--version"]]],
    firefox: [["firefox", ["--version"]]],
  };
  return Object.fromEntries(
    Object.entries(candidates).map(([name, commands]) => {
      for (const [command, args] of commands) {
        const version = firstVersion(runVersion(command, args));
        if (version) return [name, version];
      }
      return [name, null];
    }),
  );
}

export function collectBaseline() {
  const dotnetOutput = runVersion("dotnet", ["--list-sdks"]);
  const dotnetSdks = dotnetOutput
    ? dotnetOutput.split(/\r?\n/).map((line) => line.match(/^(\S+)\s/)?.[1]).filter(Boolean)
    : [];
  return {
    schema_id: "https://schemas.cloudingenium.com/ci-actions/runner-baseline/v1",
    schema_version: 1,
    collected_at: new Date().toISOString(),
    runner: {
      name: process.env.RUNNER_NAME || null,
      os: process.platform,
      os_release: os.release(),
      architecture: process.arch,
      hostname: os.hostname(),
      boot_id: readBootId(process.platform),
    },
    tools: {
      dotnet_sdks: dotnetSdks,
      node: process.versions.node,
      pnpm: firstVersion(runVersion("pnpm", ["--version"])),
      powershell: firstVersion(runVersion("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"])),
      git: firstVersion(runVersion("git", ["--version"])),
      browsers: browserVersions(),
    },
  };
}

export function evaluateBaseline(manifest, rawRequirements) {
  const requirements = assertPlainObject(rawRequirements, "baseline requirements");
  const allowed = new Set([
    "os",
    "architecture",
    "dotnet_sdk",
    "node_major",
    "pnpm",
    "powershell_major",
    "git_minimum",
    "browser",
  ]);
  const unknown = Object.keys(requirements).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown baseline requirement(s): ${unknown.join(", ")}`);

  const drift = [];
  if (requirements.os && manifest.runner.os !== requirements.os) {
    drift.push(`os expected ${requirements.os}, found ${manifest.runner.os}`);
  }
  if (requirements.architecture && manifest.runner.architecture !== requirements.architecture) {
    drift.push(`architecture expected ${requirements.architecture}, found ${manifest.runner.architecture}`);
  }
  if (requirements.dotnet_sdk) {
    if (!EXACT_DOTNET_SDK.test(requirements.dotnet_sdk)) throw new Error("dotnet_sdk must be an exact SDK version");
    if (!manifest.tools.dotnet_sdks.includes(requirements.dotnet_sdk)) {
      drift.push(`dotnet SDK ${requirements.dotnet_sdk} is not installed`);
    }
  }
  if (requirements.node_major !== undefined) {
    const expected = Number(requirements.node_major);
    if (!Number.isInteger(expected) || expected < 1) throw new Error("node_major must be a positive integer");
    if (Number(manifest.tools.node?.split(".")[0]) !== expected) {
      drift.push(`Node major ${expected} is required, found ${manifest.tools.node ?? "missing"}`);
    }
  }
  if (requirements.pnpm) {
    if (!EXACT_VERSION.test(requirements.pnpm)) throw new Error("pnpm must be an exact version");
    if (manifest.tools.pnpm !== requirements.pnpm) {
      drift.push(`pnpm ${requirements.pnpm} is required, found ${manifest.tools.pnpm ?? "missing"}`);
    }
  }
  if (requirements.powershell_major !== undefined) {
    const expected = Number(requirements.powershell_major);
    if (!Number.isInteger(expected) || expected < 1) throw new Error("powershell_major must be a positive integer");
    if (Number(manifest.tools.powershell?.split(".")[0]) !== expected) {
      drift.push(`PowerShell major ${expected} is required, found ${manifest.tools.powershell ?? "missing"}`);
    }
  }
  if (requirements.git_minimum) {
    if (!EXACT_VERSION.test(requirements.git_minimum)) throw new Error("git_minimum must be an exact version");
    if (!manifest.tools.git || compareVersions(manifest.tools.git, requirements.git_minimum) < 0) {
      drift.push(`Git >=${requirements.git_minimum} is required, found ${manifest.tools.git ?? "missing"}`);
    }
  }
  if (requirements.browser !== undefined) {
    const browser = assertPlainObject(requirements.browser, "browser requirement");
    const unknownBrowserKeys = Object.keys(browser).filter((key) => !["name", "minimum"].includes(key));
    if (unknownBrowserKeys.length > 0) {
      throw new Error(`unknown browser requirement(s): ${unknownBrowserKeys.join(", ")}`);
    }
    if (!["chrome", "edge", "firefox"].includes(browser.name)) {
      throw new Error("browser.name must be chrome, edge, or firefox");
    }
    if (browser.minimum && !EXACT_VERSION.test(browser.minimum)) {
      throw new Error("browser.minimum must be an exact version");
    }
    const installed = manifest.tools.browsers[browser.name];
    if (!installed || (browser.minimum && compareVersions(installed, browser.minimum) < 0)) {
      drift.push(`${browser.name} >=${browser.minimum ?? "any"} is required, found ${installed ?? "missing"}`);
    }
  }
  return drift;
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
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const outputRoot = process.env.RUNNER_TEMP || workspace;
  const requirements = {};

  const requirementsFile = args.get("requirements-file");
  if (requirementsFile) {
    const filePath = resolveInside(workspace, requirementsFile, "requirements-file");
    Object.assign(requirements, parseBoundedJson(await readFile(filePath, "utf8"), {
      label: "baseline requirements file",
      maxBytes: 8192,
    }));
  }
  Object.assign(requirements, parseBoundedJson(args.get("requirements-json"), {
    label: "requirements-json",
    maxBytes: 8192,
  }));

  const manifest = collectBaseline();
  const drift = evaluateBaseline(manifest, requirements);
  manifest.preflight = {
    eligible: drift.length === 0,
    drift_count: drift.length,
    drift,
  };
  const serialized = stableStringify(manifest);
  const outputPath = resolveInside(outputRoot, args.get("output-path") || "runner-baseline.json", "output-path");
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);

  await writeOutputs(args.get("github-output"), {
    "manifest-path": outputPath,
    "manifest-sha256": sha256(serialized),
    eligible: drift.length === 0 ? "true" : "false",
    drifted: drift.length === 0 ? "false" : "true",
    "drift-count": drift.length,
    "drift-reasons": JSON.stringify(drift),
  });

  const failOnDrift = parseBoolean(args.get("fail-on-drift") || "true", "fail-on-drift");
  if (drift.length > 0 && failOnDrift) {
    throw new Error(`runner baseline drift: ${drift.join("; ")}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  });
}
