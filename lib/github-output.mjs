import { appendFile } from "node:fs/promises";

export async function writeOutputs(outputPath, values) {
  if (!outputPath) return;
  const lines = [];
  for (const [name, rawValue] of Object.entries(values)) {
    const value = String(rawValue ?? "");
    if (value.includes("\n") || value.includes("\r")) {
      const delimiter = `CI_ACTION_${name.toUpperCase()}_${Date.now()}`;
      lines.push(`${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    } else {
      lines.push(`${name}=${value}\n`);
    }
  }
  await appendFile(outputPath, lines.join(""), "utf8");
}
