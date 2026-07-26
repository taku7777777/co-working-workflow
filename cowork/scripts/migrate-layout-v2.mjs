#!/usr/bin/env node

import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const dryRun = process.argv.slice(2).includes("--dry-run");
const stateRoot = resolve(
  process.env.COWORK_STATE || join(homedir(), "cowork-state"),
);

function errorCode(error) {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function sanitizeSessionId(sessionId) {
  let sanitized = sessionId.replace(/[^A-Za-z0-9._-]/gu, "-");
  if (sanitized.startsWith(".")) sanitized = `-${sanitized.slice(1)}`;
  return sanitized || "_unknown";
}

function parseRows(path, body) {
  return body
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, index }) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`invalid JSONL at ${path}:${index}`);
      }
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`JSONL row is not an object at ${path}:${index}`);
      }
      return { line, record };
    });
}

function addLines(plans, sourceFile, destinationFile, lines) {
  if (lines.length === 0) return;
  const existing = plans.get(destinationFile);
  if (existing) {
    existing.lines.push(...lines);
    existing.sources.add(sourceFile);
  } else {
    plans.set(destinationFile, {
      destinationFile,
      lines: [...lines],
      sources: new Set([sourceFile]),
    });
  }
}

async function sourceDirectories() {
  const sources = [];
  const tasksRoot = join(stateRoot, "tasks");
  for (const task of await entries(tasksRoot)) {
    if (!task.isDirectory()) continue;
    const directory = join(tasksRoot, task.name);
    if (await exists(join(directory, "instructions.jsonl"))) {
      sources.push({
        directory,
        destination: directory,
        kind: "task",
        taskId: task.name,
      });
    }
  }

  const threadsRoot = join(stateRoot, "threads");
  for (const first of await entries(threadsRoot)) {
    if (!first.isDirectory()) continue;
    if (first.name === "unfiled") {
      for (const repo of await entries(join(threadsRoot, first.name))) {
        if (!repo.isDirectory()) continue;
        for (const thread of await entries(
          join(threadsRoot, first.name, repo.name),
        )) {
          if (!thread.isDirectory()) continue;
          sources.push({
            directory: join(threadsRoot, first.name, repo.name, thread.name),
            destination: join(stateRoot, "unfiled", repo.name, thread.name),
            kind: "unfiled",
            repo: repo.name,
            threadId: thread.name,
          });
        }
      }
      continue;
    }
    for (const thread of await entries(join(threadsRoot, first.name))) {
      if (!thread.isDirectory()) continue;
      sources.push({
        directory: join(threadsRoot, first.name, thread.name),
        destination: join(stateRoot, "unfiled", first.name, thread.name),
        kind: "unfiled",
        repo: first.name,
        threadId: thread.name,
      });
    }
  }
  return sources;
}

async function planMigration() {
  const plans = new Map();
  const sources = await sourceDirectories();
  const exclusions = [];
  const metas = new Map();
  const sessionHeaders = new Set();

  for (const source of sources) {
    const instructionPath = join(source.directory, "instructions.jsonl");
    let instructionRows = [];
    if (await exists(instructionPath)) {
      instructionRows = parseRows(
        instructionPath,
        await readFile(instructionPath, "utf8"),
      );
    }
    let excluded = 0;
    for (const { line, record } of instructionRows) {
      if (
        typeof record.prompt === "string" &&
        record.prompt.trimStart().startsWith("<task-notification>")
      ) {
        excluded += 1;
        continue;
      }
      const sessionId =
        typeof record.session_id === "string" ? record.session_id : "";
      const destinationFile = join(
        source.destination,
        "sessions",
        `${sanitizeSessionId(sessionId)}.jsonl`,
      );
      if (!sessionId) {
        addLines(plans, instructionPath, destinationFile, [line]);
        continue;
      }
      const outputLines = [];
      if (!sessionHeaders.has(destinationFile)) {
        outputLines.push(
          JSON.stringify({
            kind: "meta",
            schema: 2,
            session_id: sessionId,
            by: typeof record.by === "string" ? record.by : "",
            by_name:
              typeof record.by_name === "string" ? record.by_name : "",
            repo: typeof record.repo === "string" ? record.repo : "",
            started: typeof record.ts === "string" ? record.ts : "",
          }),
        );
        sessionHeaders.add(destinationFile);
      }
      const {
        session_id: _sessionId,
        by: _by,
        by_name: _byName,
        repo: _repo,
        ...event
      } = record;
      outputLines.push(JSON.stringify(event));
      addLines(
        plans,
        instructionPath,
        destinationFile,
        outputLines,
      );
    }
    if (excluded > 0) exclusions.push({ path: instructionPath, count: excluded });

    for (const name of ["intent-log.jsonl", "receipts.jsonl"]) {
      const sourceFile = join(source.directory, name);
      if (!(await exists(sourceFile))) continue;
      const lines = (await readFile(sourceFile, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0);
      addLines(plans, sourceFile, join(source.destination, name), lines);
    }

    if (source.kind === "task") {
      metas.set(source.destination, {
        schema_version: 2,
        kind: "task",
        task_id: source.taskId,
      });
    } else {
      const firstBranch = instructionRows.find(
        ({ record }) =>
          typeof record.branch === "string" && record.branch.length > 0,
      )?.record.branch;
      metas.set(source.destination, {
        schema_version: 2,
        kind: "unfiled",
        repo: source.repo,
        branch: firstBranch || source.threadId,
      });
    }
  }
  return { plans: [...plans.values()], sources, exclusions, metas };
}

function missingLines(existingLines, sourceLines) {
  const available = new Map();
  for (const line of existingLines) {
    available.set(line, (available.get(line) || 0) + 1);
  }
  const missing = [];
  for (const line of sourceLines) {
    const count = available.get(line) || 0;
    if (count > 0) {
      available.set(line, count - 1);
    } else {
      missing.push(line);
    }
  }
  return missing;
}

async function writePlan(plan) {
  let existingLines = [];
  if (await exists(plan.destinationFile)) {
    existingLines = (await readFile(plan.destinationFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
  }
  const missing = missingLines(existingLines, plan.lines);
  if (missing.length === 0) return;
  await mkdir(dirname(plan.destinationFile), { recursive: true });
  await writeFile(
    plan.destinationFile,
    `${[...existingLines, ...missing].join("\n")}\n`,
    "utf8",
  );
}

async function removeEmptyParents(path, stop) {
  let current = dirname(path);
  while (current.startsWith(stop) && current !== dirname(stop)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    if (current === stop) return;
    current = dirname(current);
  }
}

async function migrate() {
  const { plans, sources, exclusions, metas } = await planMigration();
  process.stdout.write(`${dryRun ? "[dry-run] " : ""}layout v2 migration:\n`);
  if (sources.length === 0) {
    process.stdout.write("  no targets\n");
    return;
  }
  for (const plan of plans) {
    process.stdout.write(
      `  ${[...plan.sources].join(", ")} -> ${plan.destinationFile} (${plan.lines.length} rows)\n`,
    );
  }
  for (const exclusion of exclusions) {
    process.stdout.write(
      `  excluded notifications: ${exclusion.path} (${exclusion.count} rows)\n`,
    );
  }
  if (dryRun) return;

  for (const plan of plans) await writePlan(plan);
  for (const [directory, meta] of metas) {
    await mkdir(directory, { recursive: true });
    const metaPath = join(directory, "meta.json");
    if (!(await exists(metaPath))) {
      await writeFile(metaPath, `${JSON.stringify(meta)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    }
  }
  for (const source of sources) {
    if (source.directory !== source.destination) {
      await rm(source.directory, { recursive: true });
      await removeEmptyParents(source.directory, join(stateRoot, "threads"));
    } else {
      await rm(join(source.directory, "instructions.jsonl"));
    }
  }
}

migrate().catch((error) => {
  process.stderr.write(
    `migrate-layout-v2: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
