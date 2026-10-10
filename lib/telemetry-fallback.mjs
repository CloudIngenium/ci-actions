/**
 * Fail-open telemetry writes for persistent self-hosted runners.
 *
 * Why (measured): on a persistent runner `$RUNNER_TEMP/ci-telemetry` can already
 * exist, owned by a different user, because the runner could not wipe it at job
 * start. `mkdir(recursive)` succeeds on the existing directory, the write then
 * hits EACCES, and the observation is lost (www.DigiContas.com run 38043463487 on
 * Runner-Ubuntu-03g). CloudIngenium/.github `dotnet-ci.yml` fixed the same class
 * inline for its NuGet restore telemetry; this is the shared Node port.
 *
 * Only EACCES/EPERM trigger the fallback. Every other error propagates unchanged.
 * The fallback directory is created with `mkdtemp` under RUNNER_TEMP (or the OS
 * temp dir), so it is owned by the job user by construction; the configured path
 * keeps its `resolveInside` safety at the call site.
 */
import { appendFile, mkdir, mkdtemp, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

export function isPermissionError(error) {
  return PERMISSION_CODES.has(error?.code);
}

function escapeCommandData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function jobSlug(env) {
  const slug = String(env.GITHUB_JOB || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return slug || "job";
}

async function userName(uid) {
  try {
    const passwd = await readFile("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields.length > 2 && fields[2] === String(uid)) return fields[0];
    }
  } catch {
    // best effort: the uid alone still names the owner
  }
  return null;
}

async function describeOwner(directory) {
  try {
    const { uid } = await stat(directory);
    if (process.platform === "win32") return "unknown";
    const name = await userName(uid);
    return name ? `${name} (uid ${uid})` : `uid ${uid}`;
  } catch {
    return "unknown";
  }
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return typeof process.getuid === "function" ? `uid ${process.getuid()}` : "the job user";
  }
}

export async function createFallbackDirectory(env = process.env) {
  const base = env.RUNNER_TEMP || os.tmpdir();
  return mkdtemp(path.join(base, `ci-telemetry-${jobSlug(env)}-`));
}

async function atomicWriteFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function appendLine(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, value, { encoding: "utf8", mode: 0o600 });
}

/**
 * Returns writers that retry once in a job-owned fallback directory when the
 * configured directory refuses the write with EACCES/EPERM. Both writers resolve
 * to the path actually written. Files that shared a directory keep sharing one
 * fallback directory, so a payload and its envelope never split.
 */
export function createTelemetryWriter({
  label = "telemetry",
  env = process.env,
  warn = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const redirects = new Map();

  async function withFallback(targetPath, write) {
    const directory = path.dirname(targetPath);
    const redirected = redirects.get(directory);
    if (redirected) {
      const fallbackPath = path.join(redirected, path.basename(targetPath));
      await write(fallbackPath);
      return fallbackPath;
    }
    try {
      await write(targetPath);
      return targetPath;
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      const owner = await describeOwner(directory);
      let fallbackDirectory;
      try {
        fallbackDirectory = await createFallbackDirectory(env);
      } catch (fallbackError) {
        throw new Error(
          `${directory} is not writable (${error.code}, owner: ${owner}) and no fallback directory could be created: ${fallbackError.message}`,
        );
      }
      const fallbackPath = path.join(fallbackDirectory, path.basename(targetPath));
      await write(fallbackPath);
      redirects.set(directory, fallbackDirectory);
      warn(`::warning::${escapeCommandData(
        `${directory} is not writable by ${currentUser()} (${error.code}, owner: ${owner}); ${label} goes to ${fallbackDirectory} instead.`,
      )}`);
      return fallbackPath;
    }
  }

  return {
    atomicWrite: (filePath, value) => withFallback(filePath, (target) => atomicWriteFile(target, value)),
    append: (filePath, value) => withFallback(filePath, (target) => appendLine(target, value)),
  };
}
