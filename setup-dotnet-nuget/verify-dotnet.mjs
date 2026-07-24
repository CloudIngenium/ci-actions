#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const expected = process.argv[2];
const installed = execFileSync("dotnet", ["--list-sdks"], {
  encoding: "utf8",
  timeout: 10000,
  windowsHide: true,
})
  .split(/\r?\n/)
  .map((line) => line.match(/^(\S+)\s/)?.[1])
  .filter(Boolean);
if (!installed.includes(expected)) {
  process.stderr.write(`::error::.NET SDK ${expected} is unavailable after setup\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`Using .NET SDK ${expected}\n`);
}
