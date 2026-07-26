import test from "node:test";
import assert from "node:assert/strict";
import {
  displayName,
  deriveThreadId,
  determineBadges,
  extractAskUserQuestionAnswer,
  generateBrief,
} from "../src/lib.ts";

test("thread_id is derived from every branch without repository prefixes", () => {
  assert.equal(deriveThreadId("feature/0042-x"), "feature-0042-x");
  assert.equal(deriveThreadId("main"), "main");
  assert.equal(deriveThreadId("master"), "master");
  assert.equal(deriveThreadId("HEAD"), "HEAD");
  assert.equal(deriveThreadId(""), "_unknown");
});

test("badges reflect distinct intents and objections", () => {
  assert.deepEqual(
    determineBadges(
      [{ hash: "a" }, { hash: "a" }, { hash: "b" }],
      [
        { kind: "read", by_name: "Reader" },
        { kind: "object", by_name: "田中" },
        { kind: "object", by_name: "田中" },
      ],
    ),
    ["方針変更", "object:田中"],
  );
  assert.deepEqual(determineBadges([{ hash: "a" }], []), []);
});

test("display names never expose a full email address", () => {
  assert.equal(displayName("", "takuto@example.com"), "takuto");
  assert.equal(displayName(undefined, "tanaka@example.com"), "tanaka");
  assert.equal(displayName("tanaka@example.com", "tanaka@example.com"), "tanaka");
  assert.equal(displayName("田中", "tanaka@example.com"), "田中");
});

test("brief follows the sharing template and folds prompt newlines", () => {
  const output = generateBrief({
    threadId: "feature-0042-x",
    branch: "feature/0042-x",
    intentEntries: [{ body: "- なぜ: テストする\n- 何を: CLI" }],
    instructions: [
      { prompt: "最初の指示\n続き" },
      { prompt: "次の指示" },
    ],
  });
  assert.equal(
    output,
    `## スレッド: feature-0042-x

### 方針
- なぜ: テストする
- 何を: CLI

### 判断したこと
- <選んだ案> ← <棄却した案> を採らなかった理由

### 現在地
- 終わったこと:
- 残っていること:
- ブランチ: feature/0042-x

### AIに出した指示(時系列)
- 最初の指示 続き
- 次の指示
`,
  );
});

test("AskUserQuestion uses full questions instead of headers", () => {
  assert.deepEqual(
    extractAskUserQuestionAnswer(
      {
        questions: [
          { question: "いつ実施しますか？", header: "実施時間" },
          { question: "対象は？", header: "対象" },
        ],
        answers: {
          "いつ実施しますか？": "今夜",
          "対象は？": "全環境",
        },
        annotations: {
          "いつ実施しますか？": { notes: "22時以降" },
        },
      },
    ),
    {
      status: "answer",
      text: "いつ実施しますか？ → 今夜 — 22時以降\n対象は？ → 全環境",
    },
  );
});

test("AskUserQuestion uses the string response as-is", () => {
  const response = 'The user answered: "実施時間"="今夜"';
  assert.deepEqual(extractAskUserQuestionAnswer(response), {
    status: "answer",
    text: response,
  });
});

test("AskUserQuestion skips rejected tool use", () => {
  assert.deepEqual(
    extractAskUserQuestionAnswer("User rejected tool use"),
    { status: "skipped" },
  );
});

test("AskUserQuestion reports unrecognized response shapes", () => {
  assert.deepEqual(extractAskUserQuestionAnswer({ answers: {} }), {
    status: "unrecognized",
  });
});

test("brief prefixes AskUserQuestion answers", () => {
  const output = generateBrief({
    threadId: "feature-0042-x",
    branch: "feature/0042-x",
    intentEntries: [],
    instructions: [
      { prompt: "通常の指示" },
      { kind: "answer", prompt: "いつ実施しますか？ → 今夜" },
    ],
  });
  assert.match(
    output,
    /### AIに出した指示\(時系列\)\n- 通常の指示\n- \(回答\) いつ実施しますか？ → 今夜/u,
  );
});

test("brief displays SessionStart records as chronological boundaries", () => {
  const input = {
    threadId: "feature-0042-x",
    branch: "feature/0042-x",
    intentEntries: [],
    instructions: [
      { kind: "session", source: "startup", session_id: "session-1" },
      { prompt: "最初の指示", session_id: "session-1" },
      { kind: "session", source: "resume", session_id: "session-2" },
      { prompt: "再開後の指示", session_id: "session-2" },
      { kind: "session", source: "clear", session_id: "session-3" },
      { prompt: "clear 後の指示", session_id: "session-3" },
      { kind: "session", source: "compact", session_id: "session-4" },
      { prompt: "compact 後の指示", session_id: "session-4" },
      { kind: "session", source: "future-source", session_id: "session-5" },
    ],
  };
  const expected = [
    "— 新規セッション —",
    "- 最初の指示",
    "— セッション再開 —",
    "- 再開後の指示",
    "— clear 後に開始 —",
    "- clear 後の指示",
    "— compact 後に継続 —",
    "- compact 後の指示",
    "— セッション —",
  ].join("\n");

  const output = generateBrief(input);
  assert.match(output, new RegExp(expected, "u"));
  assert.doesNotMatch(output, /— 別セッション —/u);

  const fullOutput = generateBrief({ ...input, full: true });
  assert.match(fullOutput, new RegExp(expected, "u"));
});

test("brief infers a boundary when adjacent legacy records change session_id", () => {
  const output = generateBrief({
    threadId: "feature-0042-x",
    branch: "feature/0042-x",
    intentEntries: [],
    instructions: [
      { prompt: "旧セッションの指示", session_id: "legacy-1" },
      { prompt: "別セッションの指示", session_id: "legacy-2" },
      { prompt: "同じセッションの続き", session_id: "legacy-2" },
    ],
  });
  assert.match(
    output,
    /- 旧セッションの指示\n— 別セッション —\n- 別セッションの指示\n- 同じセッションの続き/u,
  );
});

test("brief truncates only AI messages and preserves chronological order", () => {
  const longAiMessage = "あ".repeat(201);
  const input = {
    threadId: "feature-0042-x",
    branch: "feature/0042-x",
    intentEntries: [],
    instructions: [
      { prompt: "最初の指示" },
      { kind: "answer", prompt: "質問全文 → 回答" },
      { kind: "ai", prompt: longAiMessage },
      { prompt: "次の指示" },
    ],
  };
  const output = generateBrief(input);
  assert.match(
    output,
    new RegExp(
      `- 最初の指示\\n- \\(回答\\) 質問全文 → 回答\\n- \\(AI\\) ${"あ".repeat(200)}…\\(全201字\\)\\n- 次の指示`,
      "u",
    ),
  );

  const fullOutput = generateBrief({ ...input, full: true });
  assert.match(fullOutput, new RegExp(`- \\(AI\\) ${longAiMessage}\\n`, "u"));
  assert.doesNotMatch(fullOutput, /…\(全201字\)/u);
});

test("brief preserves template placeholders when logs are empty", () => {
  const output = generateBrief({
    threadId: "_unfiled",
    branch: "main",
    intentEntries: [],
    instructions: [],
  });
  assert.match(output, /- なぜ:       <なぜやるか。1〜2行>/u);
  assert.match(output, /- <指示1>\n- <指示2>\n$/u);
});
