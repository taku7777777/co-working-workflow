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

function parseInstructionRows(body: string): Record<string, unknown>[] {
  const rows = parseRows(body);
  const header = rows.find((row) => row.kind === "meta");
  const inherited = header
    ? {
        session_id: header.session_id,
        by: header.by,
        by_name: header.by_name,
        repo: header.repo,
      }
    : {};
  return rows
    .filter((row) => row.kind !== "meta")
    .map((row) => ({ ...inherited, ...row }));
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
  ).flatMap(parseInstructionRows);
  assert.deepEqual(
    rows.map((row) => [row.repo, row.branch, row.prompt]),
    [
      ["repo-alpha", "feature/alpha", "alpha instruction"],
      ["repo-beta", "feature/beta", "beta instruction"],
    ],
  );
  const intentRow = JSON.parse(
      (
        await readFile(
          join(state, "tasks", "0003-multi-repo", "intent-log.jsonl"),
          "utf8",
        )
      ).trim(),
    ) as Record<string, unknown>;
  assert.equal(intentRow.body, "- なぜ: task intent\n");
  assert.equal(
    intentRow.path,
    "repo-alpha/docs/cowork/0003-multi-repo/intent.md",
  );
  await assert.rejects(
    readFile(
      join(state, "unfiled", "repo-alpha", "feature-alpha"),
      "utf8",
    ),
    /ENOENT/u,
  );
});

test("capture discovers task child intents from a non-git task root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-root-intent-"));
  const state = join(root, "state");
  const home = join(root, "home");
  const taskRoot = join(root, "task-root");
  const repo = join(taskRoot, "repo-child");
  await mkdir(home);
  await writeFile(
    join(home, ".gitconfig"),
    "[user]\n\temail = global@example.com\n\tname = Global Tester\n",
    "utf8",
  );
  await writeMarker(taskRoot, "task-root");
  await gitDirectory(repo);
  const intent = join(repo, "docs", "cowork", "task-root", "intent.md");
  await mkdir(join(repo, "docs", "cowork", "task-root"), { recursive: true });
  await writeFile(intent, "- なぜ: root capture\n", "utf8");

  const captured = run(["capture"], {
    cwd: taskRoot,
    state,
    home,
    input: {
      cwd: taskRoot,
      session_id: "task-root",
      prompt: "task root instruction",
    },
  });
  assert.equal(captured.status, 0, captured.stderr);
  const rows = parseRows(
    await readFile(join(state, "tasks", "task-root", "intent-log.jsonl"), "utf8"),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "- なぜ: root capture\n");
  assert.equal(rows[0].path, "repo-child/docs/cowork/task-root/intent.md");

  const fromRepo = run(["capture"], {
    cwd: repo,
    state,
    input: {
      cwd: repo,
      session_id: "repo-child",
      prompt: "repo instruction",
    },
  });
  assert.equal(fromRepo.status, 0, fromRepo.stderr);
  assert.equal(
    parseRows(
      await readFile(join(state, "tasks", "task-root", "intent-log.jsonl"), "utf8"),
    ).length,
    1,
  );
});

test("marker-less capture outside git never reads a relative intent path", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-no-marker-intent-"));
  const state = join(root, "state");
  const home = join(root, "home");
  const outsideGit = join(root, "outside-git");
  await mkdir(home);
  await mkdir(join(outsideGit, "docs", "cowork", "HEAD"), { recursive: true });
  await writeFile(
    join(home, ".gitconfig"),
    "[user]\n\temail = global@example.com\n\tname = Global Tester\n",
    "utf8",
  );
  await writeFile(
    join(outsideGit, "docs", "cowork", "HEAD", "intent.md"),
    "must not be captured\n",
    "utf8",
  );
  const captured = run(["capture"], {
    cwd: outsideGit,
    state,
    home,
    input: { cwd: outsideGit, session_id: "outside", prompt: "instruction" },
  });
  assert.equal(captured.status, 0, captured.stderr);
  assert.notEqual(captured.stderr, "");
  assert.match(captured.stderr, /not a git repository/iu);
  assert.match(
    await readFile(join(state, "capture-errors.log"), "utf8"),
    /not a git repository/iu,
  );
  await assert.rejects(
    readFile(join(state, "unfiled", "_unknown", "HEAD", "intent-log.jsonl")),
    /ENOENT/u,
  );
});

test("explicit task brief ignores an unrelated malformed cwd marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-broken-marker-"));
  const state = join(root, "state");
  const repo = join(root, "repo");
  const directory = join(state, "tasks", "healthy-task");
  await gitDirectory(repo);
  await mkdir(join(repo, ".cowork"), { recursive: true });
  await writeFile(join(repo, ".cowork", "task.json"), "{broken JSON\n", "utf8");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "intent-log.jsonl"),
    `${JSON.stringify({ hash: "healthy", body: "- なぜ: healthy intent\n" })}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "instructions.jsonl"),
    `${JSON.stringify({
      ts: "2026-08-01T00:00:00.000Z",
      branch: "feature/healthy",
      prompt: "healthy instruction",
    })}\n`,
    "utf8",
  );

  const result = run(["brief", "tasks/healthy-task"], { cwd: repo, state });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^## スレッド: healthy-task/u);
  assert.match(result.stdout, /- なぜ: healthy intent/u);
  assert.match(result.stdout, /- healthy instruction/u);
});

test("multi-repository intents deduplicate per path without a false badge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-multi-intent-"));
  const state = join(root, "state");
  const taskRoot = join(root, "multi-intent");
  const repos = [join(taskRoot, "repo-a"), join(taskRoot, "repo-b")];
  await writeMarker(taskRoot, "multi-intent");
  for (const [index, repo] of repos.entries()) {
    await gitDirectory(repo, `feature/repo-${index}`);
    const directory = join(repo, "docs", "cowork", "multi-intent");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "intent.md"), `intent ${index}\n`, "utf8");
  }
  for (const [index, cwd] of [repos[0], repos[1], repos[0], repos[1]].entries()) {
    const captured = run(["capture"], {
      cwd,
      state,
      input: {
        cwd,
        session_id: `alternating-${index}`,
        prompt: `instruction ${index}`,
      },
    });
    assert.equal(captured.status, 0, captured.stderr);
  }
  const rows = parseRows(
    await readFile(join(state, "tasks", "multi-intent", "intent-log.jsonl"), "utf8"),
  );
  assert.deepEqual(
    rows.map((row) => row.path),
    [
      "repo-a/docs/cowork/multi-intent/intent.md",
      "repo-b/docs/cowork/multi-intent/intent.md",
    ],
  );
  const listed = run(["list", "--all"], { cwd: repos[0], state });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /方針変更/u);
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
  const taskRows = parseInstructionRows(
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
  assert.match(
    taskBrief.stdout,
    /\(未設定: notes\/docs\/cowork\/non-git-task\/intent\.md に置くと、ここに表示されます\)/u,
  );

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
    parseInstructionRows(
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
  assert.match(
    taskBrief.stdout,
    /\(未設定: <リポジトリ>\/docs\/cowork\/shared\/intent\.md に置くと、ここに表示されます\)/u,
  );

  const threadBrief = run(["brief", "unfiled/repo-a/shared"], { cwd: repo, state });
  assert.equal(threadBrief.status, 0, threadBrief.stderr);
  assert.match(threadBrief.stdout, /^## スレッド: repo-a\/shared/u);
  assert.match(threadBrief.stdout, /thread instruction/u);
  assert.match(
    threadBrief.stdout,
    /\(未設定: repo-a\/docs\/cowork\/shared\/intent\.md に置くと、ここに表示されます\)/u,
  );

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

test("legacy path-less intents remain readable across list, why, and brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-legacy-intent-"));
  const state = join(root, "state");
  const repo = join(root, "repo");
  await gitDirectory(repo);
  const directory = join(state, "tasks", "legacy-intent");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "intent-log.jsonl"),
    [
      { ts: "2026-07-01T00:00:00.000Z", hash: "old-a", body: "old\n" },
      { ts: "2026-07-02T00:00:00.000Z", hash: "old-b", body: "new\n" },
      {
        ts: "2026-07-03T00:00:00.000Z",
        hash: "old-b",
        body: "new\n",
        path: "repo/docs/cowork/legacy-intent/intent.md",
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(directory, "instructions.jsonl"),
    `${JSON.stringify({
      ts: "2026-07-03T00:00:00.000Z",
      branch: "feature/legacy",
      kind: "answer",
      prompt: "旧質問 → 旧回答",
    })}\n`,
    "utf8",
  );

  const listed = run(["list", "--all"], { cwd: repo, state });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /legacy-intent.*\[方針変更\]/u);

  const why = run(["why", "tasks/legacy-intent"], { cwd: repo, state });
  assert.equal(why.status, 0, why.stderr);
  assert.match(why.stdout, /### 方針変更/u);
  assert.match(why.stdout, /- old/u);
  assert.match(why.stdout, /\+ new/u);

  const brief = run(["brief", "tasks/legacy-intent"], { cwd: repo, state });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /### 方針\nnew/u);
  assert.match(brief.stdout, /### 判断したこと\n- 旧質問 → 旧回答/u);
  assert.doesNotMatch(
    brief.stdout.split("### AIに出した指示(時系列)\n")[1] ?? "",
    /旧質問/u,
  );
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
        kind: "meta",
        schema: 2,
        session_id: "alpha",
        by: "alpha@example.com",
        by_name: "Alpha",
        repo: "repo-a",
        started: "2026-07-26T00:00:00.000Z",
      },
      {
        ts: "2026-07-26T00:00:00.000Z",
        prompt: "alpha first",
        branch: "feature/ordered",
      },
      {
        kind: "meta",
        schema: 2,
        session_id: "wrong",
        by: "wrong@example.com",
        by_name: "Wrong",
        repo: "wrong",
        started: "2026-07-26T00:30:00.000Z",
      },
      {
        ts: "2026-07-26T05:00:00.000Z",
        prompt: "alpha last",
        branch: "feature/ordered",
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await writeFile(
    join(sessions, "beta.jsonl"),
    [
      {
        kind: "meta",
        schema: 2,
        session_id: "beta",
        by: "beta@example.com",
        by_name: "Beta",
        repo: "repo-a",
        started: "2026-07-26T01:00:00.000Z",
      },
      {
        ts: "2026-07-26T01:00:00.000Z",
        prompt: "beta first",
        branch: "feature/ordered",
      },
      {
        ts: "2026-07-26T02:00:00.000Z",
        prompt: "beta last",
        branch: "feature/ordered",
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );

  const brief = run(["brief", "feature-ordered"], { cwd: repo, state });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(
    brief.stdout,
    /alpha first[\s\S]*alpha last[\s\S]*— 別セッション —[\s\S]*beta first[\s\S]*beta last/u,
  );
  assert.doesNotMatch(brief.stdout, /Wrong/u);

  const list = run(["list", "--all"], { cwd: repo, state });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /unfiled\/repo-a\/feature-ordered.*Alpha/u);
});
