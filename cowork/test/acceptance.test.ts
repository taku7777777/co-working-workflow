import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/cowork.js");

interface RunOptions {
  cwd?: string;
  state?: string;
  input?: string;
}

function run(
  args: readonly string[],
  { cwd, state, input }: RunOptions = {},
) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, COWORK_STATE: state },
    input,
    encoding: "utf8",
  });
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function parseObject(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test("MVP-0 capture, brief, list, why, and receipt flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-acceptance-"));
  const repo = join(root, "work");
  const state = join(root, "state");
  await mkdir(repo);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "takuto@example.com"]);
  runGit(repo, ["config", "user.name", "takuto"]);
  runGit(repo, ["checkout", "-b", "feature/0042-x"]);

  const intentDirectory = join(repo, "docs", "cowork", "feature-0042-x");
  const intentPath = join(intentDirectory, "intent.md");
  await mkdir(intentDirectory, { recursive: true });
  await writeFile(intentPath, "- なぜ: 最初の方針\n- 何を: CLI\n", "utf8");
  runGit(repo, ["add", "docs/cowork/feature-0042-x/intent.md"]);
  runGit(repo, ["commit", "-m", "add intent"]);

  const init = run(["init"], { cwd: repo, state });
  assert.equal(init.status, 0, init.stderr);
  runGit(state, ["rev-parse", "--is-inside-work-tree"]);
  assert.equal(
    await readFile(join(state, ".gitattributes"), "utf8"),
    "*.jsonl merge=union\n",
  );
  const secondInit = run(["init"], { cwd: repo, state });
  assert.equal(secondInit.status, 0, secondInit.stderr);
  assert.equal(
    await readFile(join(state, ".gitattributes"), "utf8"),
    "*.jsonl merge=union\n",
  );

  const payload = JSON.stringify({
    session_id: "session-1",
    cwd: repo,
    transcript_path: "/local/transcript",
    prompt: "最初の指示\n続きを実装",
    hook_event_name: "UserPromptSubmit",
  });
  const first = run(["capture"], { cwd: repo, state, input: payload });
  assert.equal(first.status, 0, first.stderr);

  const thread = join(state, "unfiled", "work", "feature-0042-x");
  const instructionRows = (await readFile(join(thread, "sessions", "session-1.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(parseObject);
  assert.equal(instructionRows.length, 2);
  assert.deepEqual(instructionRows[0], {
    kind: "meta",
    schema: 2,
    session_id: "session-1",
    by: "takuto@example.com",
    by_name: "takuto",
    repo: "work",
    started: instructionRows[1].ts,
  });
  assert.equal(instructionRows[1].prompt, "最初の指示\n続きを実装");
  assert.deepEqual(Object.keys(instructionRows[1]), [
    "ts",
    "branch",
    "prompt",
  ]);

  const second = run(["capture"], { cwd: repo, state, input: payload });
  assert.equal(second.status, 0, second.stderr);
  let intentRows = (await readFile(join(thread, "intent-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(parseObject);
  assert.equal(intentRows.length, 1, "unchanged intent must not be appended");

  await writeFile(intentPath, "- なぜ: 更新した方針\n- 何を: CLI\n", "utf8");
  const third = run(["capture"], {
    cwd: repo,
    state,
    input: JSON.stringify({ ...parseObject(payload), prompt: "方針を更新" }),
  });
  assert.equal(third.status, 0, third.stderr);
  intentRows = (await readFile(join(thread, "intent-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(parseObject);
  assert.equal(intentRows.length, 2);

  const brief = run(["brief"], { cwd: repo, state });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /^## スレッド: work\/feature-0042-x\n\n### 方針\n/u);
  assert.match(brief.stdout, /- ブランチ: feature\/0042-x/u);
  assert.match(
    brief.stdout,
    /### AIに出した指示\(時系列\)\n- 最初の指示 続きを実装/u,
  );

  runGit(repo, ["checkout", "-b", "t-plain"]);
  const plainCapture = run(["capture"], {
    cwd: repo,
    state,
    input: JSON.stringify({
      cwd: repo,
      session_id: "session-plain",
      prompt: "バッジなしの指示",
    }),
  });
  assert.equal(plainCapture.status, 0, plainCapture.stderr);
  runGit(repo, ["checkout", "feature/0042-x"]);

  const listBefore = run(["list"], { cwd: repo, state });
  assert.equal(listBefore.status, 0, listBefore.stderr);
  assert.match(listBefore.stdout, /▼ 要確認 \(1\)/u);
  assert.match(listBefore.stdout, /\[方針変更\]/u);
  assert.match(listBefore.stdout, /▶ その他 \(1件\)/u);

  const why = run(["why", "feature-0042-x"], { cwd: repo, state });
  assert.equal(why.status, 0, why.stderr);
  assert.match(why.stdout, /### 方針変更/u);
  assert.match(why.stdout, /- - なぜ: 最初の方針/u);
  assert.match(why.stdout, /\+ - なぜ: 更新した方針/u);

  const objectReceipt = run(
    [
      "receipt",
      "feature-0042-x",
      "--kind",
      "object",
      "--note",
      "異議あり",
    ],
    { cwd: repo, state },
  );
  assert.equal(objectReceipt.status, 0, objectReceipt.stderr);
  const listAfterObject = run(["list"], { cwd: repo, state });
  assert.match(listAfterObject.stdout, /▼ 要確認 \(1\)/u);
  assert.match(listAfterObject.stdout, /\[object:takuto\]/u);
  assert.match(listAfterObject.stdout, /▶ その他 \(1件\)/u);

  const receiptPath = join(thread, "receipts.jsonl");
  const beforeInvalid = await readFile(receiptPath, "utf8");
  const invalidReceipt = run(
    ["receipt", "feature-0042-x", "--kind", "yomimashita"],
    { cwd: repo, state },
  );
  assert.equal(invalidReceipt.status, 1);
  assert.match(invalidReceipt.stderr, /invalid --kind "yomimashita"/u);
  assert.equal(await readFile(receiptPath, "utf8"), beforeInvalid);

  const readReceipt = run(
    [
      "receipt",
      "feature-0042-x",
      "--kind",
      "read",
      "--note",
      "確認済み",
    ],
    { cwd: repo, state },
  );
  assert.equal(readReceipt.status, 0, readReceipt.stderr);
  const listAfter = run(["list"], { cwd: repo, state });
  assert.match(listAfter.stdout, /▼ 要確認 \(0\)/u);
  assert.match(listAfter.stdout, /▶ その他 \(2件\)/u);

  const listAll = run(["list", "--all"], { cwd: repo, state });
  assert.match(listAll.stdout, /▼ 要確認 \(0\)/u);
  assert.match(listAll.stdout, /▼ 確認済み \(1件\)/u);
  assert.match(listAll.stdout, /feature-0042-x/u);
  assert.match(listAll.stdout, /▼ バッジなし \(1件\)/u);
  assert.match(listAll.stdout, /t-plain/u);
});

test("capture exits zero even when the state path cannot be written", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-failure-"));
  const repo = join(root, "work");
  const stateFile = join(root, "not-a-directory");
  await mkdir(repo);
  await writeFile(stateFile, "file", "utf8");
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);

  const result = run(["capture"], {
    cwd: repo,
    state: stateFile,
    input: JSON.stringify({ cwd: repo, prompt: "must not block" }),
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /cowork capture:/u);
});

test("unfiled threads from different repositories never mix", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-unfiled-"));
  const state = join(root, "state");
  const repoAlpha = join(root, "repo-alpha");
  const repoBeta = join(root, "repo-beta");

  for (const repo of [repoAlpha, repoBeta]) {
    await mkdir(repo);
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "tester"]);
    runGit(repo, ["checkout", "-B", "main"]);
  }

  const cases = [
    {
      repo: repoAlpha,
      threadId: "main",
      prompt: "alpha だけの指示",
      intent: "- なぜ: alpha の方針\n",
    },
    {
      repo: repoBeta,
      threadId: "main",
      prompt: "beta だけの指示",
      intent: "- なぜ: beta の方針\n",
    },
  ];

  for (const entry of cases) {
    const intentDirectory = join(
      entry.repo,
      "docs",
      "cowork",
      entry.threadId,
    );
    await mkdir(intentDirectory, { recursive: true });
    await writeFile(join(intentDirectory, "intent.md"), entry.intent, "utf8");
    const result = run(["capture"], {
      cwd: entry.repo,
      state,
      input: JSON.stringify({
        cwd: entry.repo,
        session_id: entry.threadId,
        prompt: entry.prompt,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
  }

  assert.deepEqual(
    (await readdir(join(state, "unfiled"))).sort(),
    ["repo-alpha", "repo-beta"],
  );

  const alphaBrief = run(["brief"], { cwd: repoAlpha, state });
  assert.match(alphaBrief.stdout, /## スレッド: repo-alpha\/main/u);
  assert.match(alphaBrief.stdout, /alpha の方針/u);
  assert.match(alphaBrief.stdout, /alpha だけの指示/u);
  assert.doesNotMatch(alphaBrief.stdout, /beta/u);

  const betaBrief = run(["brief"], { cwd: repoBeta, state });
  assert.match(betaBrief.stdout, /## スレッド: repo-beta\/main/u);
  assert.match(betaBrief.stdout, /beta の方針/u);
  assert.match(betaBrief.stdout, /beta だけの指示/u);
  assert.doesNotMatch(betaBrief.stdout, /alpha/u);

  const listAll = run(["list", "--all"], { cwd: repoAlpha, state });
  assert.match(listAll.stdout, /repo-alpha\/main/u);
  assert.match(listAll.stdout, /repo-beta\/main/u);
});

test("thread arguments reject ambiguity and accept repo-qualified names", async () => {
  const root = await mkdtemp(join(tmpdir(), "cowork-qualified-"));
  const state = join(root, "state");
  const repoAlpha = join(root, "repo-alpha");
  const repoBeta = join(root, "repo-beta");

  for (const [repo, prompt] of [
    [repoAlpha, "alpha の指示"],
    [repoBeta, "beta の指示"],
  ]) {
    await mkdir(repo);
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "tester"]);
    runGit(repo, ["checkout", "-b", "feature/shared"]);
    const captured = run(["capture"], {
      cwd: repo,
      state,
      input: JSON.stringify({
        cwd: repo,
        session_id: basename(repo),
        prompt,
      }),
    });
    assert.equal(captured.status, 0, captured.stderr);
  }

  const ambiguous = run(["brief", "feature-shared"], {
    cwd: repoAlpha,
    state,
  });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /thread "feature-shared" is ambiguous/u);
  assert.match(ambiguous.stderr, /repo-alpha\/feature-shared/u);
  assert.match(ambiguous.stderr, /repo-beta\/feature-shared/u);
  assert.match(
    ambiguous.stderr,
    /Specify tasks\/<id> or unfiled\/<repo>\/<thread>/u,
  );

  const qualified = run(["brief", "unfiled/repo-alpha/feature-shared"], {
    cwd: repoBeta,
    state,
  });
  assert.equal(qualified.status, 0, qualified.stderr);
  assert.match(
    qualified.stdout,
    /^## スレッド: repo-alpha\/feature-shared/u,
  );
  assert.match(qualified.stdout, /alpha の指示/u);
  assert.doesNotMatch(qualified.stdout, /beta の指示/u);

  const ambiguousReceipt = run(
    ["receipt", "feature-shared", "--kind", "read"],
    { cwd: repoAlpha, state },
  );
  assert.equal(ambiguousReceipt.status, 1);
  assert.match(ambiguousReceipt.stderr, /is ambiguous/u);

  const qualifiedReceipt = run(
    ["receipt", "unfiled/repo-alpha/feature-shared", "--kind", "read"],
    { cwd: repoAlpha, state },
  );
  assert.equal(qualifiedReceipt.status, 0, qualifiedReceipt.stderr);
  const receipt = parseObject(
    (
      await readFile(
        join(
          state,
          "unfiled",
          "repo-alpha",
          "feature-shared",
          "receipts.jsonl",
        ),
        "utf8",
      )
    ).trim(),
  );
  assert.equal(receipt.thread, "unfiled/repo-alpha/feature-shared");

  const qualifiedWhy = run(["why", "unfiled/repo-alpha/feature-shared"], {
    cwd: repoBeta,
    state,
  });
  assert.equal(qualifiedWhy.status, 0, qualifiedWhy.stderr);
  assert.match(
    qualifiedWhy.stdout,
    /^## unfiled\/repo-alpha\/feature-shared のバッジ根拠/u,
  );
});
