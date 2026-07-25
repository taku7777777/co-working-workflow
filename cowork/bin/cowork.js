#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MIN_NODE_VERSION = "22.18.0";
const args = process.argv.slice(2);
const command = args[0] || "";

function versionParts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(current, minimum) {
  const left = versionParts(current);
  const right = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function logCaptureError(message) {
  try {
    const root = resolve(
      process.env.COWORK_STATE || join(homedir(), "cowork-state"),
    );
    mkdirSync(root, { recursive: true });
    appendFileSync(
      join(root, "capture-errors.log"),
      `${new Date().toISOString()} ${message.replace(/\s+/gu, " ")}\n`,
      "utf8",
    );
  } catch {
    // The state location itself may be the reason logging failed.
  }
}

function reportFailure(message) {
  process.stderr.write(`cowork ${command}: ${message}\n`);
  if (command === "capture") {
    logCaptureError(message);
    return 0;
  }
  return 1;
}

async function main() {
  if (!versionAtLeast(process.versions.node, MIN_NODE_VERSION)) {
    return reportFailure(
      `Node.js ${MIN_NODE_VERSION} or newer is required for native TypeScript type stripping; current version is ${process.versions.node}. Upgrade Node.js, then reinstall cowork with pnpm.`,
    );
  }

  try {
    const module = await import("../src/cli.ts");
    if (typeof module.run !== "function") {
      throw new Error("../src/cli.ts does not export run()");
    }
    const code = await module.run(args);
    return command === "capture" ? 0 : code;
  } catch (error) {
    return reportFailure(errorMessage(error));
  }
}

main()
  .then((code) => {
    process.exitCode = command === "capture" ? 0 : code;
  })
  .catch((error) => {
    process.exitCode = reportFailure(errorMessage(error));
  });
