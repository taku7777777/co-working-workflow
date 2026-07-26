import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/cowork.js");

interface RunOptions {
  cwd: string;
  state: string;
  input?: Record<string, unknown>;
  home?: string;
}

function run(args: readonly string[], options: RunOptions) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      COWORK_STATE: options.state,
      ...(options.home ? { HOME: options.home } : {}),
    },
    input: options.input ? JSON.stringify(options.input) : undefined,
    encoding: "utf8",
  });
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function gitDirectory(path: string, branch = "feature/task"): Promise<void> {
  await mkdir(path, { recursive: true });
  runGit(path, ["init"]);
  runGit(path, ["config", "user.email", "task@example.com"]);
  runGit(path, ["config", "user.name", "Task Tester"]);
  runGit(path, ["checkout", "-b", branch]);
}

async function writeMarker(root: string, taskId: string): Promise<void> {
  const markerDirectory = join(root, ".cowork");
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(
    join(markerDirectory, "task.json"),
    `${JSON.stringify({
      task_id: taskId,
      created: "2026-07-26T00:00:00.000Z",
      created_by: "task@example.com",
    })}\n`,
    "utf8",
  );
}

function parseRows(body: string): Record<string, unknown>[] {
  return body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("task new creates a canonical marker and validates IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-new-"));
  const state = join(root, "state");
  await gitDirectory(root);

  const created = run(["task", "new", "0002-policy-redesign"], {
    cwd: root,
    state,
  });
  assert.equal(created.status, 0, created.stderr);
  const marker = JSON.parse(
    await readFile(
      join(root, "0002-policy-redesign", ".cowork", "task.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(marker.task_id, "0002-policy-redesign");
  assert.equal(marker.created_by, "task@example.com");
  assert.equal(typeof marker.created, "string");
  assert.equal(
    Number.isFinite(Date.parse(String(marker.created))),
    true,
  );
  const meta = JSON.parse(
    await readFile(
      join(state, "tasks", "0002-policy-redesign", "meta.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.deepEqual(meta, {
    schema_version: 2,
    kind: "task",
    task_id: "0002-policy-redesign",
    created: marker.created,
    created_by: "task@example.com",
  });

  for (const [id, message] of [
    ["", /must not be empty/u],
    ["nested/id", /must not contain "\/"/u],
    [".private", /must not start with "\."/u],
  ] as const) {
    const invalid = run(["task", "new", id], { cwd: root, state });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, message);
  }
});

test("task new rejects state task and unfiled thread collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-collision-"));
  const state = join(root, "state");
  await gitDirectory(root);
  await mkdir(join(state, "tasks", "existing-task"), { recursive: true });
  await mkdir(join(state, "unfiled", "repo-a", "existing-thread"), {
    recursive: true,
  });

  const taskCollision = run(["task", "new", "existing-task"], {
    cwd: root,
    state,
  });
  assert.equal(taskCollision.status, 1);
  assert.match(taskCollision.stderr, /already exists at tasks\/existing-task/u);

  const threadCollision = run(["task", "new", "existing-thread"], {
    cwd: root,
    state,
  });
  assert.equal(threadCollision.status, 1);
  assert.match(threadCollision.stderr, /conflicts with existing thread/u);
  assert.match(threadCollision.stderr, /repo-a\/existing-thread/u);
});

test("capture finds a parent marker and keeps each repository context", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-capture-"));
  const state = join(root, "state");
  const taskRoot = join(root, "0003-multi-repo");
  const repoAlpha = join(taskRoot, "repo-alpha");
  const repoBeta = join(taskRoot, "repo-beta");
  await writeMarker(taskRoot, "0003-multi-repo");
  await gitDirectory(repoAlpha, "feature/alpha");
  await gitDirectory(repoBeta, "feature/beta");
  const nestedAlpha = join(repoAlpha, "packages", "nested");
  await mkdir(nestedAlpha, { recursive: true });
  const intentDirectory = join(
    repoAlpha,
    "docs",
    "cowork",
    "0003-multi-repo",
  );
  await mkdir(intentDirectory, { recursive: true });
  await writeFile(
    join(intentDirectory, "intent.md"),
    "- なぜ: task intent\n",
    "utf8",
  );

  for (const [cwd, prompt] of [
    [nestedAlpha, "alpha instruction"],
    [repoBeta, "beta instruction"],
  ]) {
    const captured = run(["capture"], {
      cwd,
      state,
      input: {
        cwd,
        session_id: prompt,
        hook_event_name: "UserPromptSubmit",
        prompt,
      },
    });
    assert.equal(captured.status, 0, captured.stderr);
  }

  const rows = (
    await Promise.all(
      ["alpha-instruction.jsonl", "beta-instruction.jsonl"].map((name) =>
        readFile(
          join(state, "tasks", "0003-multi-repo", "sessions", name),
          "utf8",
        ),
      ),
    )
  ).flatMap(parseRows);
  assert.deepEqual(
    rows.map((row) => [row.repo, row.branch, row.prompt]),
    [
      ["repo-alpha", "feature/alpha", "alpha instruction"],
      ["repo-beta", "feature/beta", "beta instruction"],
    ],
  );
  assert.equal(
    JSON.parse(
      (
        await readFile(
          join(state, "tasks", "0003-multi-repo", "intent-log.jsonl"),
          "utf8",
        )
      ).trim(),
    ).body,
    "- なぜ: task intent\n",
  );
  await assert.rejects(
    readFile(
      join(state, "unfiled", "repo-alpha", "feature-alpha"),
      "utf8",
    ),
    /ENOENT/u,
  );
});

test("marker detection works outside git and marker-less capture keeps fallback routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-detection-"));
  const state = join(root, "state");
  const home = join(root, "home");
  const taskRoot = join(root, "non-git-task");
  const nested = join(taskRoot, "notes", "nested");
  await mkdir(home);
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(home, ".gitconfig"),
    "[user]\n\temail = global@example.com\n\tname = Global Tester\n",
    "utf8",
  );
  await writeMarker(taskRoot, "non-git-task");

  const taskCapture = run(["capture"], {
    cwd: nested,
    state,
    home,
    input: {
      cwd: nested,
      session_id: "non-git",
      prompt: "outside git",
    },
  });
  assert.equal(taskCapture.status, 0, taskCapture.stderr);
  const taskRows = parseRows(
    await readFile(
      join(state, "tasks", "non-git-task", "sessions", "non-git.jsonl"),
      "utf8",
    ),
  );
  assert.equal(taskRows[0].repo, "");
  assert.equal(taskRows[0].branch, "HEAD");

  const taskBrief = run(["brief"], { cwd: nested, state, home });
  assert.equal(taskBrief.status, 0, taskBrief.stderr);
  assert.match(taskBrief.stdout, /^## スレッド: non-git-task/u);
  assert.match(taskBrief.stdout, /outside git/u);

  const namedTaskBrief = run(["brief", "non-git-task"], {
    cwd: nested,
    state,
    home,
  });
  assert.equal(namedTaskBrief.status, 0, namedTaskBrief.stderr);
  assert.match(namedTaskBrief.stdout, /^## スレッド: non-git-task/u);

  const currentReceipt = run(["receipt", "--kind", "read"], {
    cwd: nested,
    state,
    home,
  });
  assert.equal(currentReceipt.status, 0, currentReceipt.stderr);
  assert.equal(
    JSON.parse(
      (
        await readFile(
          join(state, "tasks", "non-git-task", "receipts.jsonl"),
          "utf8",
        )
      ).trim(),
    ).thread,
    "tasks/non-git-task",
  );

  const currentWhy = run(["why"], { cwd: nested, state, home });
  assert.equal(currentWhy.status, 0, currentWhy.stderr);
  assert.match(
    currentWhy.stdout,
    /^## tasks\/non-git-task のバッジ根拠/u,
  );

  const fallbackRepo = join(root, "fallback-repo");
  await gitDirectory(fallbackRepo, "feature/fallback");
  const fallbackCapture = run(["capture"], {
    cwd: fallbackRepo,
    state,
    input: {
      cwd: fallbackRepo,
      session_id: "fallback",
      prompt: "fallback instruction",
    },
  });
  assert.equal(fallbackCapture.status, 0, fallbackCapture.stderr);
  assert.equal(
    parseRows(
      await readFile(
        join(
          state,
          "unfiled",
          "fallback-repo",
          "feature-fallback",
          "sessions",
          "fallback.jsonl",
        ),
        "utf8",
      ),
    )[0].prompt,
    "fallback instruction",
  );
});

test("task and thread resolution reports ambiguity and accepts qualifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-resolution-"));
  const state = join(root, "state");
  const repo = join(root, "repo-a");
  await gitDirectory(repo, "feature/shared");
  const taskDirectory = join(state, "tasks", "shared");
  const threadDirectory = join(state, "unfiled", "repo-a", "shared");
  await mkdir(taskDirectory, { recursive: true });
  await mkdir(threadDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "instructions.jsonl"),
    `${JSON.stringify({
      ts: "2026-07-26T00:00:00.000Z",
      repo: "repo-a",
      branch: "feature/task",
      prompt: "task instruction",
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(threadDirectory, "instructions.jsonl"),
    `${JSON.stringify({
      ts: "2026-07-26T00:00:00.000Z",
      repo: "repo-a",
      branch: "feature/shared",
      prompt: "thread instruction",
    })}\n`,
    "utf8",
  );

  const ambiguous = run(["brief", "shared"], { cwd: repo, state });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /thread "shared" is ambiguous/u);
  assert.match(
    ambiguous.stderr,
    /tasks\/shared[\s\S]*repo-a\/shared/u,
  );
  assert.match(
    ambiguous.stderr,
    /Specify tasks\/<id> or unfiled\/<repo>\/<thread>/u,
  );

  const taskBrief = run(["brief", "tasks/shared"], { cwd: repo, state });
  assert.equal(taskBrief.status, 0, taskBrief.stderr);
  assert.match(taskBrief.stdout, /^## スレッド: shared/u);
  assert.match(taskBrief.stdout, /task instruction/u);
  assert.doesNotMatch(taskBrief.stdout, /thread instruction/u);

  const threadBrief = run(["brief", "unfiled/repo-a/shared"], { cwd: repo, state });
  assert.equal(threadBrief.status, 0, threadBrief.stderr);
  assert.match(threadBrief.stdout, /^## スレッド: repo-a\/shared/u);
  assert.match(threadBrief.stdout, /thread instruction/u);

  const taskReceipt = run(
    ["receipt", "tasks/shared", "--kind", "read"],
    { cwd: repo, state },
  );
  assert.equal(taskReceipt.status, 0, taskReceipt.stderr);
  assert.equal(
    JSON.parse(
      (await readFile(join(taskDirectory, "receipts.jsonl"), "utf8")).trim(),
    ).thread,
    "tasks/shared",
  );

  const taskWhy = run(["why", "tasks/shared"], { cwd: repo, state });
  assert.equal(taskWhy.status, 0, taskWhy.stderr);
  assert.match(taskWhy.stdout, /^## tasks\/shared のバッジ根拠/u);

  const list = run(["list", "--all"], { cwd: repo, state });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /tasks\/shared/u);
  assert.match(list.stdout, /repo-a\/shared/u);
});

test("instruction streams are concatenated by first timestamp and list uses the maximum timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-stream-order-"));
  const state = join(root, "state");
  const repo = join(root, "repo-a");
  await gitDirectory(repo, "feature/ordered");
  const directory = join(state, "unfiled", "repo-a", "feature-ordered");
  const sessions = join(directory, "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, "alpha.jsonl"),
    [
      {
        ts: "2026-07-26T00:00:00.000Z",
        session_id: "alpha",
        prompt: "alpha first",
        by_name: "Alpha",
        branch: "feature/ordered",
      },
      {
        ts: "2026-07-26T05:00:00.000Z",
        session_id: "alpha",
        prompt: "alpha last",
        by_name: "Latest",
        branch: "feature/ordered",
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await writeFile(
    join(sessions, "beta.jsonl"),
    [
      {
        ts: "2026-07-26T01:00:00.000Z",
        session_id: "beta",
        prompt: "beta first",
        by_name: "Beta",
        branch: "feature/ordered",
      },
      {
        ts: "2026-07-26T02:00:00.000Z",
        session_id: "beta",
        prompt: "beta last",
        by_name: "Beta",
        branch: "feature/ordered",
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );

  const brief = run(["brief", "feature-ordered"], { cwd: repo, state });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(
    brief.stdout,
    /alpha first[\s\S]*alpha last[\s\S]*beta first[\s\S]*beta last/u,
  );

  const list = run(["list", "--all"], { cwd: repo, state });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /unfiled\/repo-a\/feature-ordered.*Latest/u);
});
