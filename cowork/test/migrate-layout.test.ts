import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const migrationScript = resolve("scripts/migrate-layout.mjs");

function runMigration(state: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [migrationScript, ...args], {
    env: { ...process.env, COWORK_STATE: state },
    encoding: "utf8",
  });
}

test("layout migration splits unfiled rows and is dry-run safe and idempotent", async () => {
  const state = await mkdtemp(join(tmpdir(), "cowork-migration-"));
  const threads = join(state, "threads");
  const legacyTask = join(threads, "feature-shared");
  const legacyCollision = join(threads, "feature-collision");
  const legacyUnfiled = join(threads, "_unfiled-repo-a");
  await mkdir(legacyTask, { recursive: true });
  await mkdir(legacyCollision, { recursive: true });
  await mkdir(legacyUnfiled, { recursive: true });

  const taskLine = JSON.stringify({
    ts: "2026-01-01T00:00:00.000Z",
    repo: "repo-a",
    branch: "feature/shared",
    prompt: "task",
  });
  const taskUnknownLine = JSON.stringify({
    ts: "2026-01-01T00:01:00.000Z",
    repo: "repo-a",
    prompt: "missing branch",
  });
  const intentLine = JSON.stringify({
    ts: "2026-01-01T00:02:00.000Z",
    hash: "intent-a",
    body: "intent",
  });
  await writeFile(
    join(legacyTask, "instructions.jsonl"),
    `${taskLine}\n${taskUnknownLine}\n`,
    "utf8",
  );
  await writeFile(
    join(legacyTask, "intent-log.jsonl"),
    `${intentLine}\n`,
    "utf8",
  );

  const collisionAlphaFirst = JSON.stringify({
    ts: "2026-01-01T01:00:00.000Z",
    repo: "repo-a",
    branch: "feature/collision",
    prompt: "alpha-1",
  });
  const collisionBeta = JSON.stringify({
    ts: "2026-01-01T01:01:00.000Z",
    repo: "repo-b",
    branch: "feature/collision",
    prompt: "beta",
  });
  const collisionAlphaSecond = JSON.stringify({
    ts: "2026-01-01T01:02:00.000Z",
    repo: "repo-a",
    branch: "feature/collision",
    prompt: "alpha-2",
  });
  await writeFile(
    join(legacyCollision, "instructions.jsonl"),
    `${collisionAlphaFirst}\n${collisionBeta}\n${collisionAlphaSecond}\n`,
    "utf8",
  );

  const mainFirst = JSON.stringify({
    ts: "2026-01-02T00:00:00.000Z",
    repo: "repo-a",
    branch: "main",
    prompt: "main-1",
  });
  const master = JSON.stringify({
    ts: "2026-01-02T00:01:00.000Z",
    repo: "repo-a",
    branch: "master",
    prompt: "master",
  });
  const mainSecond = JSON.stringify({
    ts: "2026-01-02T00:02:00.000Z",
    repo: "repo-a",
    branch: "main",
    prompt: "main-2",
  });
  const unfiledUnknown = JSON.stringify({
    ts: "2026-01-02T00:03:00.000Z",
    repo: "repo-a",
    prompt: "unknown",
  });
  await writeFile(
    join(legacyUnfiled, "instructions.jsonl"),
    `${mainFirst}\n${master}\n${mainSecond}\n${unfiledUnknown}\n`,
    "utf8",
  );

  const dryRun = runMigration(state, ["--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /^\[dry-run\] 移行対象と移行先:/u);
  assert.match(dryRun.stdout, /repo-a\/feature-shared\/instructions\.jsonl/u);
  assert.match(dryRun.stdout, /unfiled\/repo-a\/main\/instructions\.jsonl/u);
  assert.match(dryRun.stdout, /repo\/branch フィールドが無いため/u);
  assert.equal(
    await readFile(join(legacyTask, "instructions.jsonl"), "utf8"),
    `${taskLine}\n${taskUnknownLine}\n`,
  );
  await assert.rejects(
    readFile(
      join(threads, "repo-a", "feature-shared", "instructions.jsonl"),
      "utf8",
    ),
    /ENOENT/u,
  );

  const migrated = runMigration(state);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /^移行対象と移行先:/u);
  assert.equal(
    await readFile(
      join(threads, "repo-a", "feature-shared", "instructions.jsonl"),
      "utf8",
    ),
    `${taskLine}\n`,
  );
  assert.equal(
    await readFile(
      join(threads, "repo-a", "feature-shared", "intent-log.jsonl"),
      "utf8",
    ),
    `${intentLine}\n`,
  );
  assert.equal(
    await readFile(
      join(threads, "repo-a", "feature-collision", "instructions.jsonl"),
      "utf8",
    ),
    `${collisionAlphaFirst}\n${collisionAlphaSecond}\n`,
  );
  assert.equal(
    await readFile(
      join(threads, "repo-b", "feature-collision", "instructions.jsonl"),
      "utf8",
    ),
    `${collisionBeta}\n`,
  );
  assert.equal(
    await readFile(
      join(threads, "unfiled", "repo-a", "main", "instructions.jsonl"),
      "utf8",
    ),
    `${mainFirst}\n${mainSecond}\n`,
  );
  assert.equal(
    await readFile(
      join(threads, "unfiled", "repo-a", "master", "instructions.jsonl"),
      "utf8",
    ),
    `${master}\n`,
  );
  const unknownPath = join(
    threads,
    "unfiled",
    "repo-a",
    "_unknown",
    "instructions.jsonl",
  );
  assert.deepEqual(
    (await readFile(unknownPath, "utf8")).trim().split("\n").sort(),
    [taskUnknownLine, unfiledUnknown].sort(),
  );

  const beforeSecondRun = await Promise.all([
    readFile(
      join(threads, "repo-a", "feature-shared", "instructions.jsonl"),
      "utf8",
    ),
    readFile(
      join(threads, "unfiled", "repo-a", "main", "instructions.jsonl"),
      "utf8",
    ),
    readFile(unknownPath, "utf8"),
  ]);
  const secondRun = runMigration(state);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.match(secondRun.stdout, /対象なし/u);
  assert.deepEqual(
    await Promise.all([
      readFile(
        join(threads, "repo-a", "feature-shared", "instructions.jsonl"),
        "utf8",
      ),
      readFile(
        join(threads, "unfiled", "repo-a", "main", "instructions.jsonl"),
        "utf8",
      ),
      readFile(unknownPath, "utf8"),
    ]),
    beforeSecondRun,
  );
});
