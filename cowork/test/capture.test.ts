import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/cowork.js");

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(name: string): Promise<{
  repo: string;
  state: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `cowork-${name}-`));
  const repo = join(root, "work");
  await mkdir(repo);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Tester"]);
  runGit(repo, ["checkout", "-b", "feature/capture"]);
  return { repo, state: join(root, "state") };
}

function capture(
  state: string,
  input: Record<string, unknown>,
) {
  return spawnSync(process.execPath, [cli, "capture"], {
    input: JSON.stringify(input),
    env: { ...process.env, COWORK_STATE: state },
    encoding: "utf8",
  });
}

async function instructionRows(
  state: string,
): Promise<Record<string, unknown>[]> {
  const body = await readFile(
    join(state, "threads", "feature-capture", "instructions.jsonl"),
    "utf8",
  );
  return body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("capture exits zero for malformed input and appends an error log", async () => {
  const state = await mkdtemp(join(tmpdir(), "cowork-capture-error-"));
  const result = spawnSync(process.execPath, [cli, "capture"], {
    input: "not-json",
    env: { ...process.env, COWORK_STATE: state },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /cowork capture:/u);
  const errors = await readFile(join(state, "capture-errors.log"), "utf8");
  assert.match(errors, /^\d{4}-\d\d-\d\dT.*Unexpected token/u);
});

test("capture exits zero when required fields are absent", async () => {
  const state = await mkdtemp(join(tmpdir(), "cowork-capture-field-"));
  const result = spawnSync(process.execPath, [cli, "capture"], {
    input: JSON.stringify({ user_message: "wrong field" }),
    env: { ...process.env, COWORK_STATE: state },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /"cwd"/u);
});

test("capture appends all SessionStart sources as session records", async () => {
  const { repo, state } = await fixture("capture-session-start");
  const sources = ["startup", "resume", "clear", "compact"];
  for (const source of sources) {
    const result = capture(state, {
      session_id: `session-${source}`,
      transcript_path: `/transcripts/${source}.jsonl`,
      cwd: repo,
      hook_event_name: "SessionStart",
      source,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const rows = await instructionRows(state);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.source),
    sources,
  );
  for (const [index, row] of rows.entries()) {
    assert.equal(row.kind, "session");
    assert.equal(row.session_id, `session-${sources[index]}`);
    assert.equal(row.by, "test@example.com");
    assert.equal(row.by_name, "Tester");
    assert.equal(row.repo, "work");
    assert.equal(row.branch, "feature/capture");
    assert.equal(typeof row.ts, "string");
    assert.equal("prompt" in row, false);
  }
});

test("capture preserves unknown SessionStart sources", async () => {
  const { repo, state } = await fixture("capture-unknown-session-source");
  const result = capture(state, {
    session_id: "session-future",
    transcript_path: "/transcripts/future.jsonl",
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "future-source",
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = await instructionRows(state);
  assert.equal(rows[0].kind, "session");
  assert.equal(rows[0].source, "future-source");
});

test("capture exits zero and logs an invalid SessionStart payload", async () => {
  const { repo, state } = await fixture("capture-invalid-session");
  const result = capture(state, {
    session_id: "session-invalid",
    cwd: repo,
    hook_event_name: "SessionStart",
    source: 42,
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /string field "source"/u);
  const errors = await readFile(join(state, "capture-errors.log"), "utf8");
  assert.match(errors, /string field "source"/u);
});

test("capture appends AskUserQuestion PostToolUse as an answer", async () => {
  const { repo, state } = await fixture("capture-answer");
  const result = capture(state, {
    session_id: "session-answer",
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{ question: "いつ実施しますか？", header: "実施時間" }],
    },
    tool_response: {
      answers: { "いつ実施しますか？": "今夜" },
      annotations: { "いつ実施しますか？": { notes: "22時以降" } },
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = await instructionRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "session-answer");
  assert.equal(rows[0].kind, "answer");
  assert.equal(rows[0].prompt, "いつ実施しますか？ → 今夜 — 22時以降");
});

test("capture preserves UserPromptSubmit prompt behavior", async () => {
  const { repo, state } = await fixture("capture-prompt");
  const result = capture(state, {
    session_id: "session-prompt",
    cwd: repo,
    hook_event_name: "UserPromptSubmit",
    prompt: "既存の指示",
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = await instructionRows(state);
  assert.equal(rows[0].prompt, "既存の指示");
  assert.equal("kind" in rows[0], false);
});

test("capture accepts user_message when prompt is absent", async () => {
  const { repo, state } = await fixture("capture-user-message");
  const result = capture(state, {
    session_id: "session-user-message",
    cwd: repo,
    hook_event_name: "UserPromptSubmit",
    user_message: "表記揺れの指示",
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = await instructionRows(state);
  assert.equal(rows[0].prompt, "表記揺れの指示");
});

test("capture silently skips unrelated PostToolUse events", async () => {
  const { state } = await fixture("capture-unrelated-tool");
  const result = capture(state, {
    session_id: "session-unrelated",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_response: "file contents",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  await assert.rejects(
    readFile(join(state, "capture-errors.log"), "utf8"),
    /ENOENT/u,
  );
});

test("capture logs unrecognized AskUserQuestion responses with session ID", async () => {
  const { state } = await fixture("capture-unrecognized-answer");
  const result = capture(state, {
    session_id: "session-unknown-shape",
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_response: { answers: {} },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const errors = await readFile(join(state, "capture-errors.log"), "utf8");
  assert.match(
    errors,
    /AskUserQuestion tool_response を解釈できなかった \(session_id: session-unknown-shape\)/u,
  );
});

test("capture appends a Stop message as an AI instruction", async () => {
  const { repo, state } = await fixture("capture-stop");
  const result = capture(state, {
    session_id: "session-stop",
    cwd: repo,
    hook_event_name: "Stop",
    last_assistant_message: "実装が完了しました。\nテストも成功しています。",
    stop_hook_active: false,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = await instructionRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "session-stop");
  assert.equal(rows[0].kind, "ai");
  assert.equal(
    rows[0].prompt,
    "実装が完了しました。\nテストも成功しています。",
  );
});

test("capture silently skips an empty Stop message", async () => {
  const { repo, state } = await fixture("capture-empty-stop");
  const result = capture(state, {
    session_id: "session-empty-stop",
    cwd: repo,
    hook_event_name: "Stop",
    last_assistant_message: " \n ",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  await assert.rejects(
    readFile(
      join(state, "threads", "feature-capture", "instructions.jsonl"),
      "utf8",
    ),
    /ENOENT/u,
  );
});

test("capture snapshots intent changes on Stop", async () => {
  const { repo, state } = await fixture("capture-stop-intent");
  const intentDirectory = join(
    repo,
    "docs",
    "cowork",
    "feature-capture",
  );
  await mkdir(intentDirectory, { recursive: true });
  await writeFile(
    join(intentDirectory, "intent.md"),
    "- なぜ: Stop 時点の方針\n",
    "utf8",
  );
  const result = capture(state, {
    session_id: "session-stop-intent",
    cwd: repo,
    hook_event_name: "Stop",
    last_assistant_message: "方針を更新しました。",
  });
  assert.equal(result.status, 0, result.stderr);
  const intentLog = await readFile(
    join(state, "threads", "feature-capture", "intent-log.jsonl"),
    "utf8",
  );
  const row = JSON.parse(intentLog.trim()) as Record<string, unknown>;
  assert.equal(row.body, "- なぜ: Stop 時点の方針\n");
});

test("brief accepts a thread with --full and shows the full AI message", async () => {
  const { repo, state } = await fixture("brief-full");
  const longAiMessage = "応".repeat(201);
  const captured = capture(state, {
    session_id: "session-brief-full",
    cwd: repo,
    hook_event_name: "Stop",
    last_assistant_message: longAiMessage,
  });
  assert.equal(captured.status, 0, captured.stderr);

  const result = spawnSync(
    process.execPath,
    [cli, "brief", "feature-capture", "--full"],
    {
      cwd: repo,
      env: { ...process.env, COWORK_STATE: state },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`- \\(AI\\) ${longAiMessage}\\n`, "u"));
  assert.doesNotMatch(result.stdout, /…\(全201字\)/u);
});
