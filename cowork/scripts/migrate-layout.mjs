#!/usr/bin/env node

import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const dryRun = process.argv.slice(2).includes("--dry-run");
const stateRoot = resolve(
  process.env.COWORK_STATE || join(homedir(), "cowork-state"),
);
const threadsRoot = join(stateRoot, "threads");

function errorCode(error) {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function parseRecord(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function field(record, key) {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function threadName(branch) {
  return branch.replace(/\//gu, "-");
}

function addLines(plans, sourceFile, destinationFile, lines) {
  if (lines.length === 0) return;
  const key = `${sourceFile}\0${destinationFile}`;
  const existing = plans.get(key);
  if (existing) {
    existing.lines.push(...lines);
  } else {
    plans.set(key, { sourceFile, destinationFile, lines: [...lines] });
  }
}

async function legacyDirectories() {
  const directories = [];
  for (const entry of await entries(threadsRoot)) {
    if (!entry.isDirectory() || entry.name === "unfiled") continue;
    const directory = join(threadsRoot, entry.name);
    const files = (await entries(directory)).filter(
      (child) => child.isFile() && child.name.endsWith(".jsonl"),
    );
    if (files.length > 0) {
      directories.push({ directory, files, name: entry.name });
    }
  }
  return directories;
}

async function planMigration() {
  const plans = new Map();
  const warnings = [];
  const sources = await legacyDirectories();

  for (const source of sources) {
    const instructionFile = source.files.find(
      (file) => file.name === "instructions.jsonl",
    );
    const primaryDestinations = new Set();
    const knownRepos = new Set();

    if (instructionFile) {
      const sourceFile = join(source.directory, instructionFile.name);
      const body = await readFile(sourceFile, "utf8");
      const lines = body.split("\n").filter((line) => line.length > 0);
      const unfiledRepo = source.name.startsWith("_unfiled-")
        ? source.name.slice("_unfiled-".length)
        : undefined;
      const parsedLines = lines.map((line) => ({
        line,
        record: parseRecord(line),
      }));
      for (const { record } of parsedLines) {
        const repo = field(record, "repo");
        if (repo) knownRepos.add(repo);
      }

      for (const [index, { line, record }] of parsedLines.entries()) {
        const repo = field(record, "repo");
        const branch = field(record, "branch");

        let destinationDirectory;
        if (unfiledRepo) {
          if (repo && branch) {
            destinationDirectory = join(
              threadsRoot,
              "unfiled",
              unfiledRepo,
              threadName(branch),
            );
            primaryDestinations.add(destinationDirectory);
          } else {
            destinationDirectory = join(
              threadsRoot,
              "unfiled",
              unfiledRepo,
              "_unknown",
            );
            warnings.push(
              `${sourceFile}:${index + 1}: repo/branch フィールドが無いため ${destinationDirectory} に退避`,
            );
          }
        } else if (repo && branch) {
          destinationDirectory = join(threadsRoot, repo, source.name);
          primaryDestinations.add(destinationDirectory);
        } else {
          const fallbackRepo =
            repo ||
            (knownRepos.size === 1 ? [...knownRepos][0] : "_unknown");
          destinationDirectory = join(
            threadsRoot,
            "unfiled",
            fallbackRepo,
            "_unknown",
          );
          warnings.push(
            `${sourceFile}:${index + 1}: repo/branch フィールドが無いため ${destinationDirectory} に退避`,
          );
        }
        addLines(
          plans,
          sourceFile,
          join(destinationDirectory, instructionFile.name),
          [line],
        );
      }
    }

    for (const file of source.files) {
      if (file.name === "instructions.jsonl") continue;
      const sourceFile = join(source.directory, file.name);
      const body = await readFile(sourceFile, "utf8");
      const lines = body.split("\n").filter((line) => line.length > 0);
      let destinationDirectory;
      if (primaryDestinations.size === 1) {
        destinationDirectory = [...primaryDestinations][0];
      } else {
        const fallbackRepo =
          source.name.startsWith("_unfiled-")
            ? source.name.slice("_unfiled-".length)
            : knownRepos.size === 1
              ? [...knownRepos][0]
              : "_unknown";
        destinationDirectory = join(
          threadsRoot,
          "unfiled",
          fallbackRepo,
          "_unknown",
        );
        warnings.push(
          `${sourceFile}: 移行先を一意に決められないため ${destinationDirectory} に退避`,
        );
      }
      addLines(
        plans,
        sourceFile,
        join(destinationDirectory, file.name),
        lines,
      );
    }
  }

  return { plans: [...plans.values()], sources, warnings };
}

async function migrate() {
  const { plans, sources, warnings } = await planMigration();
  process.stdout.write(
    `${dryRun ? "[dry-run] " : ""}移行対象と移行先:\n`,
  );
  if (plans.length === 0) {
    process.stdout.write("  対象なし\n");
    return;
  }
  for (const warning of warnings) {
    process.stdout.write(`  注意: ${warning}\n`);
  }
  for (const plan of plans) {
    process.stdout.write(
      `  ${plan.sourceFile} -> ${plan.destinationFile} (${plan.lines.length}行)\n`,
    );
  }
  if (dryRun) return;

  for (const plan of plans) {
    await mkdir(dirname(plan.destinationFile), { recursive: true });
    await appendFile(plan.destinationFile, `${plan.lines.join("\n")}\n`, "utf8");
  }

  for (const source of sources) {
    for (const file of source.files) {
      await unlink(join(source.directory, file.name));
    }
    try {
      await rmdir(source.directory);
    } catch (error) {
      if (errorCode(error) !== "ENOTEMPTY") throw error;
    }
  }
}

migrate().catch((error) => {
  process.stderr.write(
    `migrate-layout: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
