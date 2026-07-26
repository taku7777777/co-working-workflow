export type JsonObject = Record<string, unknown>;

export interface BriefInput {
  threadId: string;
  branch: string | undefined;
  intentEntries: readonly JsonObject[];
  instructions: readonly JsonObject[];
  full?: boolean;
}

export type AskUserQuestionAnswerExtraction =
  | { status: "answer"; text: string }
  | { status: "skipped" }
  | { status: "unrecognized" };

export const EMPTY_INTENT = `- なぜ:       <なぜやるか。1〜2行>
- 何を:       <何をするか。1〜2行>
- やらないこと: <スコープ外。1〜2行>
- 触る範囲:   <触ってよいファイル/ディレクトリ>
- 完了条件:   <これが満たされたら完了、と言える条件>`;

export const CONFIRMATION_KINDS: ReadonlySet<string> = new Set([
  "read",
  "understood-intent",
  "ran",
]);

export const RECEIPT_KINDS: ReadonlySet<string> = new Set([
  ...CONFIRMATION_KINDS,
  "object",
]);

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function displayName(byName: unknown, email: unknown): string {
  const candidate =
    typeof byName === "string" && byName.trim().length > 0
      ? byName.trim()
      : String(email ?? "").split("@")[0] ?? "";
  return candidate.includes("@") ? (candidate.split("@")[0] ?? "") : candidate;
}

export function deriveThreadId(
  branch: string | null | undefined,
): string {
  if (!branch) return "_unknown";
  return branch.replace(/\//g, "-");
}

export function determineBadges(
  intentEntries: readonly JsonObject[],
  receipts: readonly JsonObject[],
): string[] {
  const badges: string[] = [];
  const hashes = new Set<string>();
  for (const entry of intentEntries) {
    if (typeof entry.hash === "string" && entry.hash.length > 0) {
      hashes.add(entry.hash);
    }
  }
  if (hashes.size >= 2) {
    badges.push("方針変更");
  }

  const objectors = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.kind !== "object") continue;
    const name = displayName(receipt.by_name, receipt.by);
    if (name.length > 0) {
      objectors.add(name);
    }
  }
  for (const name of objectors) {
    badges.push(`object:${name}`);
  }
  return badges;
}

export function collapsePrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim();
}

export function extractAskUserQuestionAnswer(
  toolResponse: unknown,
): AskUserQuestionAnswerExtraction {
  if (typeof toolResponse === "string") {
    if (toolResponse.startsWith("User rejected")) {
      return { status: "skipped" };
    }
    return toolResponse.trim().length > 0
      ? { status: "answer", text: toolResponse }
      : { status: "unrecognized" };
  }

  if (!isJsonObject(toolResponse) || !isJsonObject(toolResponse.answers)) {
    return { status: "unrecognized" };
  }
  const answers = Object.entries(toolResponse.answers);
  if (answers.length === 0) return { status: "unrecognized" };

  const annotations = isJsonObject(toolResponse.annotations)
    ? toolResponse.annotations
    : undefined;
  const lines: string[] = [];
  for (const [question, answer] of answers) {
    if (typeof answer !== "string") continue;
    const annotation = annotations?.[question];
    const notes =
      isJsonObject(annotation) &&
      typeof annotation.notes === "string" &&
      annotation.notes.trim().length > 0
        ? ` — ${annotation.notes}`
        : "";
    lines.push(`${question} → ${answer}${notes}`);
  }
  const text = lines.join("\n");
  return text.length > 0
    ? { status: "answer", text }
    : { status: "unrecognized" };
}

function sessionBoundaryLabel(source: unknown): string {
  switch (source) {
    case "startup":
      return "— 新規セッション —";
    case "resume":
      return "— セッション再開 —";
    case "clear":
      return "— clear 後に開始 —";
    case "compact":
      return "— compact 後に継続 —";
    default:
      return "— セッション —";
  }
}

export function generateBrief({
  threadId,
  branch,
  intentEntries,
  instructions,
  full = false,
}: BriefInput): string {
  const latestIntent = intentEntries.at(-1);
  const intent =
    typeof latestIntent?.body === "string" && latestIntent.body.length > 0
      ? latestIntent.body.replace(/\n+$/u, "")
      : EMPTY_INTENT;
  const lines: string[] = [];
  let previous: JsonObject | undefined;
  for (const entry of instructions) {
    if (
      previous !== undefined &&
      previous.kind !== "session" &&
      entry.kind !== "session" &&
      typeof previous.session_id === "string" &&
      previous.session_id.length > 0 &&
      typeof entry.session_id === "string" &&
      entry.session_id.length > 0 &&
      previous.session_id !== entry.session_id
    ) {
      lines.push("— 別セッション —");
    }

    const kind = entry.kind;
    if (kind === "session") {
      lines.push(sessionBoundaryLabel(entry.source));
    } else {
      const collapsed = collapsePrompt(
        typeof entry.prompt === "string" ? entry.prompt : "",
      );
      const characters = Array.from(collapsed);
      const prompt =
        kind === "ai" && !full && characters.length > 200
          ? `${characters.slice(0, 200).join("")}…(全${characters.length}字)`
          : collapsed;
      const prefix =
        kind === "answer" ? "(回答) " : kind === "ai" ? "(AI) " : "";
      lines.push(`- ${prefix}${prompt}`);
    }
    previous = entry;
  }
  const instructionLines =
    lines.length > 0 ? lines.join("\n") : "- <指示1>\n- <指示2>";

  return `## スレッド: ${threadId}

### 方針
${intent}

### 判断したこと
- <選んだ案> ← <棄却した案> を採らなかった理由

### 現在地
- 終わったこと:
- 残っていること:
- ブランチ: ${branch || "<branch名>"}

### AIに出した指示(時系列)
${instructionLines}
`;
}

export function diffBodies(before: string, after: string): string {
  const left = before.split("\n");
  const right = after.split("\n");
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const output: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      output.push(`  ${left[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      output.push(`- ${left[i]}`);
      i += 1;
    } else {
      output.push(`+ ${right[j]}`);
      j += 1;
    }
  }
  while (i < left.length) output.push(`- ${left[i++]}`);
  while (j < right.length) output.push(`+ ${right[j++]}`);
  return output.join("\n");
}
