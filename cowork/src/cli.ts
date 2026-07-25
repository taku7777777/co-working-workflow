import { access, appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONFIRMATION_KINDS,
  RECEIPT_KINDS,
  deriveThreadId,
  determineBadges,
  displayName,
  diffBodies,
  extractAskUserQuestionAnswer,
  generateBrief,
  isJsonObject,
} from "./lib.ts";
import type { JsonObject } from "./lib.ts";

interface Identity {
  by: string;
  by_name: string;
}

interface CurrentContext {
  branch: string;
  repo: string;
  threadId: string;
}

interface ThreadData {
  threadId: string;
  instructions: JsonObject[];
  intents: JsonObject[];
  receipts: JsonObject[];
  badges: string[];
}

function stateRoot(): string {
  return resolve(process.env.COWORK_STATE || join(homedir(), "cowork-state"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function git(
  args: readonly string[],
  cwd = process.cwd(),
  required = true,
): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (!required) return "";
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function identity(cwd = process.cwd()): Identity {
  const by = git(["config", "user.email"], cwd);
  if (!by) throw new Error("git config user.email is not set");
  return {
    by,
    by_name: displayName(git(["config", "user.name"], cwd, false), by),
  };
}

function branchAt(cwd = process.cwd()): string {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, false);
  return branch || "HEAD";
}

async function stdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines(path: string): Promise<JsonObject[]> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const rows: JsonObject[] = [];
  for (const [index, line] of body.split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`invalid JSONL at ${path}:${index + 1}`);
    }
    if (!isJsonObject(parsed)) {
      throw new Error(`JSONL row is not an object at ${path}:${index + 1}`);
    }
    rows.push(parsed);
  }
  return rows;
}

function threadDir(threadId: string): string {
  return join(stateRoot(), "threads", threadId);
}

function currentContext(
  cwd = process.cwd(),
  knownTop = "",
): CurrentContext {
  const branch = branchAt(cwd);
  const top = knownTop || git(["rev-parse", "--show-toplevel"], cwd, false);
  const repo = top ? basename(top) : "";
  return { branch, repo, threadId: deriveThreadId(branch, repo) };
}

async function init(): Promise<void> {
  const root = stateRoot();
  await mkdir(join(root, "threads"), { recursive: true });
  let initialized = true;
  try {
    await access(join(root, ".git"));
  } catch {
    initialized = false;
  }
  if (!initialized) {
    const result = spawnSync("git", ["init", root], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "git init failed");
    }
  }
  process.stdout.write(`Initialized cowork state at ${root}\n`);
}

async function logCaptureError(message: string): Promise<void> {
  try {
    const root = stateRoot();
    await mkdir(root, { recursive: true });
    await appendFile(
      join(root, "capture-errors.log"),
      `${new Date().toISOString()} ${message.replace(/\s+/gu, " ")}\n`,
      "utf8",
    );
  } catch {
    // The state location itself may be the reason capture failed.
  }
}

async function capture(): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await stdin()) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error("stdin JSON must be an object");
    }

    let prompt: string;
    let kind: "answer" | "ai" | undefined;
    if (parsed.hook_event_name === "Stop") {
      if (
        typeof parsed.last_assistant_message !== "string" ||
        parsed.last_assistant_message.trim().length === 0
      ) {
        return 0;
      }
      prompt = parsed.last_assistant_message;
      kind = "ai";
    } else if (parsed.hook_event_name === "PostToolUse") {
      if (parsed.tool_name !== "AskUserQuestion") return 0;
      const extraction = extractAskUserQuestionAnswer(parsed.tool_response);
      if (extraction.status === "skipped") return 0;
      if (extraction.status === "unrecognized") {
        const sessionId =
          typeof parsed.session_id === "string" ? parsed.session_id : "";
        await logCaptureError(
          `AskUserQuestion tool_response を解釈できなかった (session_id: ${sessionId})`,
        );
        return 0;
      }
      prompt = extraction.text;
      kind = "answer";
    } else {
      const candidate =
        typeof parsed.prompt === "string"
          ? parsed.prompt
          : parsed.user_message;
      if (typeof candidate !== "string") {
        throw new Error(
          'stdin JSON must contain string field "prompt" or "user_message"',
        );
      }
      prompt = candidate;
    }
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) {
      throw new Error('stdin JSON must contain string field "cwd"');
    }

    const cwd = parsed.cwd;
    const top = git(["rev-parse", "--show-toplevel"], cwd);
    const { by, by_name } = identity(cwd);
    const { branch, repo, threadId } = currentContext(cwd, top);
    const ts = new Date().toISOString();
    const directory = threadDir(threadId);

    await appendJsonLine(join(directory, "instructions.jsonl"), {
      ts,
      by,
      by_name,
      repo,
      branch,
      session_id:
        typeof parsed.session_id === "string" ? parsed.session_id : "",
      ...(kind ? { kind } : {}),
      prompt,
    });

    const intentPath = join(top, "docs", "cowork", threadId, "intent.md");
    let body: string;
    try {
      body = await readFile(intentPath, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    }
    const hash = createHash("sha256").update(body).digest("hex");
    const logPath = join(directory, "intent-log.jsonl");
    const intents = await readJsonLines(logPath);
    if (intents.at(-1)?.hash !== hash) {
      await appendJsonLine(logPath, { ts, by, hash, body });
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    process.stderr.write(`cowork capture: ${message}\n`);
    await logCaptureError(message);
  }
  return 0;
}

function stringField(
  record: JsonObject | undefined,
  key: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

async function brief(args: readonly string[]): Promise<void> {
  const requested = args.slice(1).find((arg) => !arg.startsWith("-"));
  const full = args.includes("--full");
  const current = currentContext();
  const threadId = requested || current.threadId;
  const directory = threadDir(threadId);
  const instructions = await readJsonLines(join(directory, "instructions.jsonl"));
  const intentEntries = await readJsonLines(join(directory, "intent-log.jsonl"));
  const latestBranch = stringField(instructions.at(-1), "branch");
  const branch = requested ? latestBranch || undefined : current.branch;
  process.stdout.write(
    generateBrief({ threadId, branch, intentEntries, instructions, full }),
  );
}

function relativeTime(iso: string): string {
  const milliseconds = Date.now() - Date.parse(iso);
  if (!Number.isFinite(milliseconds)) return "時刻不明";
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h前`;
  return `${Math.floor(hours / 24)}日前`;
}

async function loadThreads(): Promise<ThreadData[]> {
  const root = join(stateRoot(), "threads");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  return Promise.all(
    directories.map(async (entry): Promise<ThreadData> => {
      const directory = join(root, entry.name);
      const [instructions, intents, receipts] = await Promise.all([
        readJsonLines(join(directory, "instructions.jsonl")),
        readJsonLines(join(directory, "intent-log.jsonl")),
        readJsonLines(join(directory, "receipts.jsonl")),
      ]);
      return {
        threadId: entry.name,
        instructions,
        intents,
        receipts,
        badges: determineBadges(intents, receipts),
      };
    }),
  );
}

function formatThread(thread: ThreadData): string {
  const latest = thread.instructions.at(-1);
  const badge =
    thread.badges.length > 0 ? `[${thread.badges.join("] [")}]` : "";
  const ts = stringField(latest, "ts");
  const time = ts ? `最終指示 ${relativeTime(ts)}` : "指示なし";
  const author = displayName(latest?.by_name, latest?.by);
  return `  ${thread.threadId.padEnd(26)} ${badge.padEnd(18)} ${time}  ${author}`.trimEnd();
}

async function list(args: readonly string[]): Promise<void> {
  const { by } = identity();
  const threads = await loadThreads();
  const confirmedBySelf = (thread: ThreadData): boolean =>
    thread.receipts.some(
      (receipt) =>
        receipt.by === by &&
        typeof receipt.kind === "string" &&
        CONFIRMATION_KINDS.has(receipt.kind),
    );
  const needsReview = threads
    .filter(
      (thread) =>
        thread.badges.length > 0 && !confirmedBySelf(thread),
    )
    .sort((a, b) =>
      stringField(b.instructions.at(-1), "ts").localeCompare(
        stringField(a.instructions.at(-1), "ts"),
      ),
    );
  const confirmed = threads
    .filter(confirmedBySelf)
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
  const withoutBadges = threads
    .filter(
      (thread) =>
        thread.badges.length === 0 && !confirmedBySelf(thread),
    )
    .sort((a, b) => a.threadId.localeCompare(b.threadId));

  process.stdout.write(`▼ 要確認 (${needsReview.length})\n`);
  for (const thread of needsReview) {
    process.stdout.write(`${formatThread(thread)}\n`);
  }
  if (args.includes("--all")) {
    process.stdout.write(`\n▼ 確認済み (${confirmed.length}件)\n`);
    for (const thread of confirmed) {
      process.stdout.write(`${formatThread(thread)}\n`);
    }
    process.stdout.write(`\n▼ バッジなし (${withoutBadges.length}件)\n`);
    for (const thread of withoutBadges) {
      process.stdout.write(`${formatThread(thread)}\n`);
    }
  } else {
    const otherCount = confirmed.length + withoutBadges.length;
    process.stdout.write(
      `\n▶ その他 (${otherCount}件)  — \`cowork list --all\` で展開\n`,
    );
  }
}

function option(
  args: readonly string[],
  name: string,
  fallback = "",
): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function receipt(args: readonly string[]): Promise<void> {
  const threadId = args[1];
  if (!threadId || threadId.startsWith("-")) {
    throw new Error("usage: cowork receipt <thread> --kind <kind> [--note <note>]");
  }
  const kind = option(args, "--kind");
  if (!kind) {
    throw new Error("--kind is required");
  }
  if (!RECEIPT_KINDS.has(kind)) {
    throw new Error(
      `invalid --kind "${kind}": expected read, understood-intent, ran, or object`,
    );
  }
  const { by, by_name } = identity();
  await appendJsonLine(join(threadDir(threadId), "receipts.jsonl"), {
    ts: new Date().toISOString(),
    by,
    by_name,
    thread: threadId,
    kind,
    note: option(args, "--note"),
  });
}

async function why(args: readonly string[]): Promise<void> {
  const threadId = args[1];
  if (!threadId || threadId.startsWith("-")) {
    throw new Error("usage: cowork why <thread>");
  }
  const directory = threadDir(threadId);
  const [intents, receipts] = await Promise.all([
    readJsonLines(join(directory, "intent-log.jsonl")),
    readJsonLines(join(directory, "receipts.jsonl")),
  ]);
  const unique: JsonObject[] = [];
  for (const entry of intents) {
    const hash = stringField(entry, "hash");
    if (hash && stringField(unique.at(-1), "hash") !== hash) {
      unique.push(entry);
    }
  }

  process.stdout.write(`## ${threadId} のバッジ根拠\n`);
  if (new Set(unique.map((entry) => stringField(entry, "hash"))).size >= 2) {
    process.stdout.write("\n### 方針変更\n");
    for (let i = 1; i < unique.length; i += 1) {
      const before = unique[i - 1];
      const after = unique[i];
      process.stdout.write(
        `\n${stringField(before, "hash").slice(0, 8)} → ${stringField(after, "hash").slice(0, 8)}\n`,
      );
      process.stdout.write(
        `${diffBodies(stringField(before, "body"), stringField(after, "body"))}\n`,
      );
    }
  }
  const objections = receipts.filter((entry) => entry.kind === "object");
  if (objections.length > 0) {
    process.stdout.write("\n### 異議\n");
    for (const entry of objections) {
      process.stdout.write(
        `- ${displayName(entry.by_name, entry.by)}: ${stringField(entry, "note") || "(note なし)"}\n`,
      );
    }
  }
  if (unique.length < 2 && objections.length === 0) {
    process.stdout.write("\nバッジの根拠はありません。\n");
  }
}

function usage(): void {
  process.stderr.write(`usage:
  cowork init
  cowork capture
  cowork brief [thread] [--full]
  cowork list [--all]
  cowork receipt <thread> --kind <kind> [--note <note>]
  cowork why <thread>
`);
}

export async function run(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  switch (args[0]) {
    case "init":
      await init();
      break;
    case "capture":
      return capture();
    case "brief":
      await brief(args);
      break;
    case "list":
      await list(args);
      break;
    case "receipt":
      await receipt(args);
      break;
    case "why":
      await why(args);
      break;
    default:
      usage();
      return 1;
  }
  return 0;
}
