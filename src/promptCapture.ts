// Prompt Capture 記錄器：只存在記憶體，每次啟動錄製都是關閉（ADR-0009）。

export type Protocol = "messages" | "responses" | "chat";

export type CaptureMessage = {
  role: "user" | "assistant" | "tool"; kind: "text" | "tool_use" | "tool_result";
  name?: string; text: string; isNew: boolean; reminder: boolean;
};

export type CaptureView = {
  id: number; time: string; client: string; model: string;
  protocol: Protocol; adapter: string;
  failedStatus?: number; webSearchFollowUp: boolean; newConversation: boolean;
  system: string[];
  tools: { name: string; description: string; schema: unknown }[];
  messages: CaptureMessage[];
  sizes: { system: number; tools: number; reminder: number; history: number; fresh: number };
  total: number; sent: unknown; raw: unknown; path: string;
};

export type CaptureList = { captures: CaptureView[]; dropped: number };

/** One model request on its way to Router. Headers never enter it. */
export type CaptureRequest = {
  /** The Client Route that asked, such as "claude" or "codex". */
  client: string;
  /** The Model API Adapter that built the request. */
  adapter: string;
  /** The path sent to Router; it decides how the body is parsed. */
  path: string;
  /** The body sent to Router. */
  sent: unknown;
  /** The client's own request body that caused it. */
  raw: unknown;
  /** Later requests of a Web Search loop. */
  webSearchFollowUp?: boolean;
};

/** Marks a recorded request as rejected by Router with this HTTP status. */
export type FailedStatus = (status: number) => void;

export type PromptCapture = {
  readonly recording: boolean;
  start(): void;
  pause(): void;
  clear(): void;
  /** Records one request while recording; otherwise does nothing. */
  record(request: CaptureRequest): FailedStatus;
  list(): CaptureList;
};

type Entry = CaptureRequest & { id: number; time: string; protocol: Protocol; failedStatus?: number };

type Parsed = Pick<CaptureView, "system" | "tools"> & { messages: Omit<CaptureMessage, "isNew">[] };
type JsonObject = Record<string, unknown>;

// 協定由送往 Router 的路徑判斷，不由客戶端判斷。新協定只要在這裡加一行。
const PROTOCOLS: { path: string; protocol: Protocol; parse: (body: JsonObject) => Parsed }[] = [
  { path: "/v1/messages", protocol: "messages", parse: parseMessages },
];

function protocolFor(path: string) {
  const route = path.split("?")[0].replace(/\/+$/, "");
  return PROTOCOLS.find(entry => route.endsWith(entry.path));
}

const noop: FailedStatus = () => {};

export function createPromptCapture(): PromptCapture {
  let recording = false;
  let entries: Entry[] = [];
  let dropped = 0;
  let nextId = 1;
  return {
    get recording() { return recording; },
    start() { recording = true; },
    pause() { recording = false; },
    clear() { entries = []; dropped = 0; },
    record(request) {
      const match = protocolFor(request.path);
      if (!recording || !match) return noop;
      const entry: Entry = { ...structuredClone(request), id: nextId++, time: clock(new Date()), protocol: match.protocol };
      entries.push(entry);
      return status => { entry.failedStatus = status; };
    },
    list() { return { captures: views(entries).reverse(), dropped }; },
  };
}

function clock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, "0")).join(":");
}

type ParsedEntry = { entry: Entry; body: JsonObject; parsed: Parsed };

// 比對規則：往前找第一筆訊息序列剛好是本筆開頭的紀錄，超出的部分是本輪新增；
// 這樣能跨過交錯出現的子 agent 或背景請求。找不到就是新對話，全部都算新增。
function views(entries: Entry[]): CaptureView[] {
  const all = entries.map(entry => {
    const body = isObject(entry.sent) ? entry.sent : {};
    return { entry, body, parsed: protocolFor(entry.path)!.parse(body) };
  });
  return all.map((current, index) => {
    const earlier = all.slice(0, index).reverse().find(other => startsWith(current.parsed.messages, other.parsed.messages));
    return view(current, earlier ? earlier.parsed.messages.length : null);
  });
}

function startsWith(messages: Parsed["messages"], prefix: Parsed["messages"]): boolean {
  if (!prefix.length || prefix.length > messages.length) return false;
  return prefix.every((message, index) => sameMessage(message, messages[index]));
}

function sameMessage(a: Parsed["messages"][number], b: Parsed["messages"][number]): boolean {
  return a.role === b.role && a.kind === b.kind && a.name === b.name && a.text === b.text;
}

/** `freshFrom` is where this turn's additions begin, or null for a new conversation. */
function view({ entry, body, parsed }: ParsedEntry, freshFrom: number | null): CaptureView {
  const messages = parsed.messages.map((message, index) => ({ ...message, isNew: index >= (freshFrom ?? 0) }));
  const sizes = { system: 0, tools: 0, reminder: 0, history: 0, fresh: 0 };
  for (const text of parsed.system) sizes.system += estimateTokens(text);
  for (const tool of parsed.tools) sizes.tools += estimateTokens(tool.name + tool.description + JSON.stringify(tool.schema ?? {}));
  for (const message of messages) {
    const size = estimateTokens((message.name ?? "") + message.text);
    if (message.reminder) sizes.reminder += size; else if (message.isNew) sizes.fresh += size; else sizes.history += size;
  }
  return {
    id: entry.id, time: entry.time, client: entry.client, model: typeof body.model === "string" ? body.model : "",
    protocol: entry.protocol, adapter: entry.adapter,
    ...(entry.failedStatus !== undefined ? { failedStatus: entry.failedStatus } : {}),
    webSearchFollowUp: entry.webSearchFollowUp === true, newConversation: freshFrom === null,
    system: parsed.system, tools: parsed.tools, messages, sizes,
    total: sizes.system + sizes.tools + sizes.reminder + sizes.history + sizes.fresh,
    sent: entry.sent, raw: entry.raw, path: entry.path,
  };
}

/** 中日韓字元每字算 1 個 token，其他字元每 4 個算 1 個。 */
function estimateTokens(text: string): number {
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function blocks(content: unknown): JsonObject[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
  return blocks(content).map(block => typeof block.text === "string" ? block.text : `[${String(block.type)}]`).join("\n");
}

const isReminder = (text: string) => text.includes("<system-reminder>");

function parseMessages(body: JsonObject): Parsed {
  const system = blocks(body.system).map(block => typeof block.text === "string" ? block.text : "").filter(Boolean);
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isObject).map(tool => ({
    name: String(tool.name ?? tool.type ?? ""),
    description: typeof tool.description === "string" ? tool.description : "",
    schema: tool.input_schema ?? null,
  }));
  const toolNames = new Map<string, string>();
  const messages: Parsed["messages"] = [];
  for (const message of Array.isArray(body.messages) ? body.messages.filter(isObject) : []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    for (const block of blocks(message.content)) {
      if (block.type === "text" && typeof block.text === "string") {
        messages.push({ role, kind: "text", text: block.text, reminder: role === "user" && isReminder(block.text) });
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "");
        if (typeof block.id === "string") toolNames.set(block.id, name);
        messages.push({ role: "assistant", kind: "tool_use", name, text: JSON.stringify(block.input ?? {}, null, 2), reminder: false });
      } else if (block.type === "tool_result") {
        const name = typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) : undefined;
        messages.push({ role: "tool", kind: "tool_result", ...(name ? { name } : {}), text: plainText(block.content), reminder: false });
      }
    }
  }
  return { system, tools, messages };
}
