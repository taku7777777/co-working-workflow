import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const migrationScript = resolve("scripts/migrate-layout-v2.mjs");

function runMigration(state: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [migrationScript, ...args], {
    env: { ...process.env, COWORK_STATE: state },
    encoding: "utf8",
  });
}

function row(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

test("layout v2 migration splits sessions, excludes notifications, and is dry-run safe and idempotent", async () => {
  const state = await mkdtemp(join(tmpdir(), "cowork-v2-migration-"));
  const task = join(state, "tasks", "task-a");
  const thread = join(state, "threads", "repo-a", "feature-a");
  const oldUnfiled = join(state, "threads", "unfiled", "repo-b", "main");
  await Promise.all([
    mkdir(task, { recursive: true }),
    mkdir(thread, { recursive: true }),
    mkdir(oldUnfiled, { recursive: true }),
  ]);

  const taskFirst = row({
    ts: "2026-01-01T00:00:00.000Z",
    session_id: "session/a",
    repo: "repo-a",
    branch: "feature/a",
    prompt: "first",
  });
  const notification = row({
    ts: "2026-01-01T00:01:00.000Z",
    session_id: "session/a",
    repo: "repo-a",
    branch: "feature/a",
    prompt: " \n<task-notification>hidden</task-notification>",
  });
  const taskSecond = row({
    ts: "2026-01-01T00:02:00.000Z",
    session_id: ".private",
    repo: "repo-b",
    branch: "feature/b",
    prompt: "second",
  });
  await writeFile(
    join(task, "instructions.jsonl"),
    `${taskFirst}\n${notification}\n${taskSecond}\n`,
  );
  await writeFile(join(task, "intent-log.jsonl"), `${row({ hash: "a" })}\n`);

  const threadRow = row({
    ts: "2026-01-02T00:00:00.000Z",
    session_id: "",
    repo: "repo-a",
    branch: "feature/a",
    prompt: "thread",
  });
  await writeFile(join(thread, "instructions.jsonl"), `${threadRow}\n`);
  await writeFile(join(thread, "receipts.jsonl"), `${row({ kind: "read" })}\n`);

  const mainRow = row({
    ts: "2026-01-03T00:00:00.000Z",
    session_id: "main",
    repo: "repo-b",
    branch: "main",
    prompt: "main",
  });
  await writeFile(join(oldUnfiled, "instructions.jsonl"), `${mainRow}\n`);

  const dryRun = runMigration(state, ["--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /^\[dry-run\] layout v2 migration:/u);
  assert.match(dryRun.stdout, /excluded notifications:.*\(1 rows\)/u);
  assert.equal(
    await readFile(join(task, "instructions.jsonl"), "utf8"),
    `${taskFirst}\n${notification}\n${taskSecond}\n`,
  );
  await assert.rejects(
    access(join(task, "sessions", "session-a.jsonl")),
    /ENOENT/u,
  );

  const migrated = runMigration(state);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(
    await readFile(join(task, "sessions", "session-a.jsonl"), "utf8"),
    `${taskFirst}\n`,
  );
  assert.equal(
    await readFile(join(task, "sessions", "-private.jsonl"), "utf8"),
    `${taskSecond}\n`,
  );
  assert.equal(
    await readFile(
      join(state, "unfiled", "repo-a", "feature-a", "sessions", "_unknown.jsonl"),
      "utf8",
    ),
    `${threadRow}\n`,
  );
  assert.equal(
    await readFile(
      join(state, "unfiled", "repo-b", "main", "sessions", "main.jsonl"),
      "utf8",
    ),
    `${mainRow}\n`,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(task, "meta.json"), "utf8")),
    { schema_version: 2, kind: "task", task_id: "task-a" },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(state, "unfiled", "repo-a", "feature-a", "meta.json"),
        "utf8",
      ),
    ),
    {
      schema_version: 2,
      kind: "unfiled",
      repo: "repo-a",
      branch: "feature/a",
    },
  );
  await assert.rejects(access(join(state, "threads")), /ENOENT/u);

  const before = await readFile(
    join(task, "sessions", "session-a.jsonl"),
    "utf8",
  );
  const secondRun = runMigration(state);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.match(secondRun.stdout, /no targets/u);
  assert.equal(
    await readFile(join(task, "sessions", "session-a.jsonl"), "utf8"),
    before,
  );
});
