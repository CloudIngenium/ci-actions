import { createHash } from "node:crypto";
import path from "node:path";

const SECRET_KEY = /^(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)$/i;
const SECRET_VALUE_PATTERNS = [
  { pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { pattern: /([?&](?:sig|token|key|password)=)[^&\s]+/gi, preservePrefix: true },
];

export function parseBoundedJson(raw, { label = "JSON", maxBytes = 8192 } = {}) {
  const value = raw?.trim() || "{}";
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

export function assertPlainObject(value, label = "value") {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function assertSafeRelativePath(value, label = "path") {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalizedInput = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalizedInput) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    normalizedInput.split("/").includes("..")
  ) {
    throw new Error(`${label} must not be absolute or contain '..'`);
  }
  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new Error(`${label} must identify a file or directory below its root`);
  }
  return normalized;
}

export function resolveInside(root, relativePath, label = "path") {
  const safe = assertSafeRelativePath(relativePath, label);
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, ...safe.split("/"));
  const relative = path.relative(absoluteRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its configured root`);
  }
  return resolved;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function redactBounded(value, options = {}) {
  const {
    maxDepth = 3,
    maxKeys = 24,
    maxStringBytes = 512,
    allowedScalarOnly = false,
  } = options;
  let redactedFields = 0;
  let visitedKeys = 0;

  function visit(input, depth, key = "") {
    if (SECRET_KEY.test(key)) {
      redactedFields += 1;
      return "[REDACTED]";
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") {
      let output = input;
      for (const { pattern, preservePrefix } of SECRET_VALUE_PATTERNS) {
        output = output.replace(pattern, (match, prefix) => {
          redactedFields += 1;
          return preservePrefix ? `${prefix}[REDACTED]` : "[REDACTED]";
        });
      }
      const bytes = Buffer.from(output, "utf8");
      if (bytes.length > maxStringBytes) {
        output = bytes.subarray(0, maxStringBytes).toString("utf8");
      }
      return output;
    }
    if (allowedScalarOnly) {
      throw new Error("metadata values must be strings, numbers, booleans, or null");
    }
    if (depth >= maxDepth) throw new Error(`metadata exceeds maximum depth ${maxDepth}`);
    if (Array.isArray(input)) {
      if (input.length > maxKeys) throw new Error(`metadata array exceeds ${maxKeys} entries`);
      return input.map((entry) => visit(entry, depth + 1));
    }
    if (typeof input === "object") {
      const output = {};
      for (const [childKey, childValue] of Object.entries(input)) {
        visitedKeys += 1;
        if (visitedKeys > maxKeys) throw new Error(`metadata exceeds ${maxKeys} keys`);
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(childKey)) {
          throw new Error(`metadata key ${JSON.stringify(childKey)} is invalid`);
        }
        output[childKey] = visit(childValue, depth + 1, childKey);
      }
      return output;
    }
    throw new Error(`unsupported metadata value type: ${typeof input}`);
  }

  return { value: visit(value, 0), redactedFields };
}

export function normalizeIso(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${label} must be an RFC 3339 timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

export function parseNonNegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${label} must not exceed ${maximum}`);
  }
  return parsed;
}

export function parseBoolean(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${label} must be true or false`);
}
