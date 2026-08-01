import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
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
  location: ThreadLocation;
}

interface ThreadLocation {
  directory: string;
  header: string;
  kind: "task" | "unfiled";
  qualified: string;
  repo: string;
  threadId: string;
}

interface TaskMarker {
  taskId: string;
  directory: string;
}

interface IntentCandidate {
  path: string;
  root: string;
}

interface ThreadData {
  location: ThreadLocation;
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

async function appendSessionEvent(
  path: string,
  header: JsonObject | undefined,
  event: JsonObject,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const includeHeader = header !== undefined && !(await pathExists(path));
  const rows = includeHeader ? [header, event] : [event];
  await appendFile(
    path,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
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

function sanitizeSessionId(sessionId: string): string {
  let sanitized = sessionId.replace(/[^A-Za-z0-9._-]/gu, "-");
  if (sanitized.startsWith(".")) {
    sanitized = `-${sanitized.slice(1)}`;
  }
  return sanitized || "_unknown";
}

async function readInstructions(directory: string): Promise<JsonObject[]> {
  const streamPaths: string[] = [];
  if (await pathExists(join(directory, "instructions.jsonl"))) {
    streamPaths.push(join(directory, "instructions.jsonl"));
  }
  const sessionsDirectory = join(directory, "sessions");
  let sessionEntries: Dirent[];
  try {
    sessionEntries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
    sessionEntries = [];
  }
  streamPaths.push(
    ...sessionEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(sessionsDirectory, entry.name)),
  );

  const streams = await Promise.all(
    streamPaths.map(async (path) => {
      const rows = await readJsonLines(path);
      const header = rows.find((row) => row.kind === "meta");
      const inherited = header
        ? Object.fromEntries(
            ["session_id", "by", "by_name", "repo"]
              .filter((key) => key in header)
              .map((key) => [key, header[key]]),
          )
        : {};
      return {
        name: basename(path),
        rows: rows
          .filter((row) => row.kind !== "meta")
          .map((row) => ({ ...inherited, ...row })),
      };
    }),
  );
  streams.sort((left, right) => {
    const leftTs = stringField(left.rows[0], "ts");
    const rightTs = stringField(right.rows[0], "ts");
    if (leftTs && rightTs && leftTs !== rightTs) {
      return leftTs.localeCompare(rightTs);
    }
    if (leftTs !== rightTs) return leftTs ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return streams.flatMap((stream) => stream.rows);
}

function latestInstruction(
  instructions: readonly JsonObject[],
): JsonObject | undefined {
  return instructions.reduce<JsonObject | undefined>((latest, instruction) => {
    if (!latest) return instruction;
    return stringField(instruction, "ts") > stringField(latest, "ts")
      ? instruction
      : latest;
  }, undefined);
}

function unfiledLocation(repo: string, branch: string): ThreadLocation {
  const pathRepo = repo || "_unknown";
  const threadId = deriveThreadId(branch);
  return {
    directory: join(stateRoot(), "unfiled", pathRepo, threadId),
    header: `${pathRepo}/${threadId}`,
    kind: "unfiled",
    qualified: `unfiled/${pathRepo}/${threadId}`,
    repo: pathRepo,
    threadId,
  };
}

function taskLocation(taskId: string): ThreadLocation {
  return {
    directory: join(stateRoot(), "tasks", taskId),
    header: taskId,
    kind: "task",
    qualified: `tasks/${taskId}`,
    repo: "",
    threadId: taskId,
  };
}

async function ensureMeta(
  location: ThreadLocation,
  branch: string,
): Promise<void> {
  await mkdir(location.directory, { recursive: true });
  const meta =
    location.kind === "task"
      ? {
          schema_version: 2,
          kind: "task",
          task_id: location.threadId,
        }
      : {
          schema_version: 2,
          kind: "unfiled",
          repo: location.repo,
          branch,
        };
  try {
    await writeFile(
      join(location.directory, "meta.json"),
      `${JSON.stringify(meta)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function taskIdError(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "task ID must not be empty";
  }
  if (value.includes("/")) {
    return 'task ID must not contain "/"';
  }
  if (value.startsWith(".")) {
    return 'task ID must not start with "."';
  }
  return undefined;
}

function validateTaskId(value: unknown): string {
  const error = taskIdError(value);
  if (error) throw new Error(error);
  return value as string;
}

async function findTaskMarker(cwd: string): Promise<TaskMarker | undefined> {
  let directory = resolve(cwd);
  while (true) {
    const path = join(directory, ".cowork", "task.json");
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`invalid task marker JSON at ${path}`);
    }
    if (!isJsonObject(parsed)) {
      throw new Error(`task marker must contain a JSON object at ${path}`);
    }
    let taskId: string;
    try {
      taskId = validateTaskId(parsed.task_id);
    } catch (error: unknown) {
      throw new Error(`invalid task marker at ${path}: ${errorMessage(error)}`);
    }
    return { taskId, directory };
  }
}

function currentContext(
  cwd = process.cwd(),
  knownTop = "",
): CurrentContext {
  const branch = branchAt(cwd);
  const top = knownTop || git(["rev-parse", "--show-toplevel"], cwd, false);
  const repo = top ? basename(top) : "";
  return { branch, repo, location: unfiledLocation(repo, branch) };
}

async function init(): Promise<void> {
  const root = stateRoot();
  await Promise.all([
    mkdir(join(root, "tasks"), { recursive: true }),
    mkdir(join(root, "unfiled"), { recursive: true }),
  ]);
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
  const attributesPath = join(root, ".gitattributes");
  let attributes = "";
  try {
    attributes = await readFile(attributesPath, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (!attributes.split(/\r?\n/u).includes("*.jsonl merge=union")) {
    await appendFile(
      attributesPath,
      `${attributes.length > 0 && !attributes.endsWith("\n") ? "\n" : ""}*.jsonl merge=union\n`,
      "utf8",
    );
  }
  process.stdout.write(`Initialized cowork state at ${root}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function markerChildDirectories(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function intentCandidates(
  top: string,
  threadId: string,
  marker: TaskMarker | undefined,
): Promise<IntentCandidate[]> {
  const candidates: IntentCandidate[] = [];
  if (top) {
    candidates.push({
      root: top,
      path: join(top, "docs", "cowork", threadId, "intent.md"),
    });
  }
  if (marker) {
    for (const child of await markerChildDirectories(marker.directory)) {
      const root = join(marker.directory, child);
      candidates.push({
        root,
        path: join(root, "docs", "cowork", marker.taskId, "intent.md"),
      });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = resolve(candidate.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    candidate.path = resolved;
    return true;
  });
}

async function task(args: readonly string[]): Promise<void> {
  if (args[1] !== "new") {
    throw new Error("usage: cowork task new <id>");
  }
  const taskId = validateTaskId(args[2]);
  const stateDirectory = taskLocation(taskId).directory;
  if (await pathExists(stateDirectory)) {
    throw new Error(`task "${taskId}" already exists at tasks/${taskId}`);
  }

  const threadCollisions = (await discoverThreadLocations())
    .filter((location) => location.threadId === taskId)
    .map((location) => location.qualified)
    .sort();
  if (threadCollisions.length > 0) {
    throw new Error(
      `task ID "${taskId}" conflicts with existing thread(s):\n${threadCollisions
        .map((candidate) => `  - ${candidate}`)
        .join("\n")}`,
    );
  }

  const markerPath = join(resolve(process.cwd(), taskId), ".cowork", "task.json");
  if (await pathExists(markerPath)) {
    throw new Error(`task marker already exists at ${markerPath}`);
  }
  const { by } = identity();
  const created = new Date().toISOString();
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(
    markerPath,
    `${JSON.stringify({
      task_id: taskId,
      created,
      created_by: by,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(stateDirectory, "meta.json"),
    `${JSON.stringify({
      schema_version: 2,
      kind: "task",
      task_id: taskId,
      created,
      created_by: by,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(`Created task "${taskId}" at ${dirname(dirname(markerPath))}\n`);
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

    let prompt: string | undefined;
    let source: string | undefined;
    let kind: "answer" | "ai" | "session" | undefined;
    if (parsed.hook_event_name === "SessionStart") {
      if (typeof parsed.source !== "string") {
        throw new Error(
          'SessionStart stdin JSON must contain string field "source"',
        );
      }
      source = parsed.source;
      kind = "session";
    } else if (parsed.hook_event_name === "Stop") {
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
      if (candidate.trimStart().startsWith("<task-notification>")) {
        return 0;
      }
      prompt = candidate;
    }
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) {
      throw new Error('stdin JSON must contain string field "cwd"');
    }

    const cwd = parsed.cwd;
    const marker = await findTaskMarker(cwd);
    const top = git(["rev-parse", "--show-toplevel"], cwd, marker === undefined);
    const { by, by_name } = identity(cwd);
    const current = currentContext(cwd, top);
    const { branch, repo } = current;
    const location = marker
      ? taskLocation(marker.taskId)
      : current.location;
    const { directory, threadId } = location;
    const ts = new Date().toISOString();
    const sessionId =
      typeof parsed.session_id === "string" ? parsed.session_id : "";

    await ensureMeta(location, branch);
    const event = {
      ts,
      ...(kind ? { kind } : {}),
      branch,
      ...(kind === "session" ? { source } : { prompt }),
    };
    const sessionPath = join(
      directory,
      "sessions",
      `${sanitizeSessionId(sessionId)}.jsonl`,
    );
    if (sessionId) {
      await appendSessionEvent(
        sessionPath,
        {
          kind: "meta",
          schema: 2,
          session_id: sessionId,
          by,
          by_name,
          repo,
          started: ts,
        },
        event,
      );
    } else {
      await appendSessionEvent(sessionPath, undefined, {
        ts,
        by,
        by_name,
        repo,
        branch,
        session_id: sessionId,
        ...(kind ? { kind } : {}),
        ...(kind === "session" ? { source } : { prompt }),
      });
    }

    const logPath = join(directory, "intent-log.jsonl");
    const intents = await readJsonLines(logPath);
    for (const candidate of await intentCandidates(top, threadId, marker)) {
      let body: string;
      try {
        body = await readFile(candidate.path, "utf8");
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      const hash = createHash("sha256").update(body).digest("hex");
      const path = join(
        basename(candidate.root),
        "docs",
        "cowork",
        threadId,
        "intent.md",
      );
      const latestForPath = intents.findLast(
        (entry) => stringField(entry, "path") === path,
      );
      if (latestForPath?.hash !== hash) {
        const entry = { ts, by, hash, body, path };
        await appendJsonLine(logPath, entry);
        intents.push(entry);
      }
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

async function childDirectories(path: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function discoverThreadLocations(): Promise<ThreadLocation[]> {
  const root = join(stateRoot(), "unfiled");
  const locations: ThreadLocation[] = [];
  for (const repo of await childDirectories(root)) {
    for (const threadId of await childDirectories(join(root, repo))) {
      locations.push({
        directory: join(root, repo, threadId),
        header: `${repo}/${threadId}`,
        kind: "unfiled",
        qualified: `unfiled/${repo}/${threadId}`,
        repo,
        threadId,
      });
    }
  }

  return locations;
}

async function discoverTaskLocations(): Promise<ThreadLocation[]> {
  const root = join(stateRoot(), "tasks");
  return (await childDirectories(root)).map(taskLocation);
}

async function discoverLocations(): Promise<ThreadLocation[]> {
  const [tasks, threads] = await Promise.all([
    discoverTaskLocations(),
    discoverThreadLocations(),
  ]);
  return [...tasks, ...threads];
}

async function resolveThread(target: string): Promise<ThreadLocation> {
  const locations = await discoverLocations();
  const qualified = target.includes("/");
  const matches = locations.filter((location) =>
    qualified
      ? location.qualified === target
      : location.threadId === target,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`thread "${target}" was not found`);
  }
  const candidates = matches
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "task" ? -1 : 1;
      return left.qualified.localeCompare(right.qualified);
    })
    .map((candidate) => `  - ${candidate.qualified}`)
    .join("\n");
  throw new Error(
    `thread "${target}" is ambiguous. Candidates:\n${candidates}\nSpecify tasks/<id> or unfiled/<repo>/<thread>.`,
  );
}

async function currentLocation(): Promise<ThreadLocation> {
  const marker = await findTaskMarker(process.cwd());
  return marker
    ? taskLocation(marker.taskId)
    : currentContext().location;
}

async function brief(args: readonly string[]): Promise<void> {
  const requested = args.slice(1).find((arg) => !arg.startsWith("-"));
  const full = args.includes("--full");
  const current = currentContext();
  const location = requested
    ? await resolveThread(requested)
    : await currentLocation();
  const { directory } = location;
  const instructions = await readInstructions(directory);
  const intentEntries = await readJsonLines(join(directory, "intent-log.jsonl"));
  const latestBranch = stringField(instructions.at(-1), "branch");
  const branch = requested ? latestBranch || undefined : current.branch;
  const expectedIntentPath = await expectedIntentPaths(location);
  process.stdout.write(
    generateBrief({
      threadId: location.header,
      branch,
      intentEntries,
      instructions,
      expectedIntentPath,
      full,
    }),
  );
}

async function expectedIntentPaths(location: ThreadLocation): Promise<string> {
  if (location.kind === "unfiled") {
    return join(
      location.repo,
      "docs",
      "cowork",
      location.threadId,
      "intent.md",
    );
  }
  try {
    const marker = await findTaskMarker(process.cwd());
    if (marker?.taskId === location.threadId) {
      const paths = (await markerChildDirectories(marker.directory)).map(
        (child) =>
          join(child, "docs", "cowork", location.threadId, "intent.md"),
      );
      if (paths.length > 0) return paths.join(", ");
    }
  } catch {
    // Expected paths are only display guidance and must not block brief output.
  }
  return join(
    "<リポジトリ>",
    "docs",
    "cowork",
    location.threadId,
    "intent.md",
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
  const locations = await discoverLocations();
  return Promise.all(
    locations.map(async (location): Promise<ThreadData> => {
      const { directory } = location;
      const [instructions, intents, receipts] = await Promise.all([
        readInstructions(directory),
        readJsonLines(join(directory, "intent-log.jsonl")),
        readJsonLines(join(directory, "receipts.jsonl")),
      ]);
      return {
        location,
        instructions,
        intents,
        receipts,
        badges: determineBadges(intents, receipts),
      };
    }),
  );
}

function formatThread(thread: ThreadData): string {
  const latest = latestInstruction(thread.instructions);
  const badge =
    thread.badges.length > 0 ? `[${thread.badges.join("] [")}]` : "";
  const ts = stringField(latest, "ts");
  const time = ts ? `最終指示 ${relativeTime(ts)}` : "指示なし";
  const author = displayName(latest?.by_name, latest?.by);
  return `  ${thread.location.qualified.padEnd(26)} ${badge.padEnd(18)} ${time}  ${author}`.trimEnd();
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
      stringField(latestInstruction(b.instructions), "ts").localeCompare(
        stringField(latestInstruction(a.instructions), "ts"),
      ),
    );
  const confirmed = threads
    .filter(confirmedBySelf)
    .sort((a, b) =>
      a.location.qualified.localeCompare(b.location.qualified),
    );
  const withoutBadges = threads
    .filter(
      (thread) =>
        thread.badges.length === 0 && !confirmedBySelf(thread),
    )
    .sort((a, b) =>
      a.location.qualified.localeCompare(b.location.qualified),
    );

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
  const target = args[1]?.startsWith("-") ? undefined : args[1];
  const location = target
    ? await resolveThread(target)
    : await currentLocation();
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
  await appendJsonLine(join(location.directory, "receipts.jsonl"), {
    ts: new Date().toISOString(),
    by,
    by_name,
    thread: location.qualified,
    kind,
    note: option(args, "--note"),
  });
}

async function why(args: readonly string[]): Promise<void> {
  const target = args[1]?.startsWith("-") ? undefined : args[1];
  const location = target
    ? await resolveThread(target)
    : await currentLocation();
  const { directory } = location;
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

  process.stdout.write(`## ${location.qualified} のバッジ根拠\n`);
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
  cowork task new <id>
  cowork capture
  cowork brief [<id>|tasks/<id>|unfiled/<repo>/<thread>] [--full]
  cowork list [--all]
  cowork receipt [<id>|tasks/<id>|unfiled/<repo>/<thread>] --kind <kind> [--note <note>]
  cowork why [<id>|tasks/<id>|unfiled/<repo>/<thread>]
`);
}

export async function run(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  switch (args[0]) {
    case "init":
      await init();
      break;
    case "task":
      await task(args);
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
