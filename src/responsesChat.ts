import { normalizeCodexRequest } from "./codexWire/request";
import { codexToolGuidance, appendToolInstructions, codeModeInputDescription } from "./codexWire/tool-guidance";
import { Buffer } from "node:buffer";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import {
  mayBecomePatchEnvelope,
  repairFreeformToolInput,
} from "./codexWire/apply-patch-envelope";
import { progressiveFreeformInput } from "./codexWire/progressive-freeform-input";
import { codexChatTools } from "./codexWire/chat-tools";
import { codexChatOptions } from "./codexWire/chat-options";
import { AdapterError, allowedFields, object, list, string } from "./adapters/types";
import {
  toolCallArgumentsCouldBeJson,
  toolCallArgumentsUsable,
} from "./codexWire/tool-arguments";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | unknown[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type ChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
    strict?: boolean;
  };
};

export type FreeformToolIdentity = { name: string; namespace?: string };

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decodeRequestBody(bytes: Buffer, encoding?: string): string {
  const enc = (encoding ?? "").toLowerCase();
  let decoded = bytes;
  if (enc.includes("zstd") || bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    decoded = zstdDecompressSync(bytes);
  } else if (enc.includes("gzip")) {
    decoded = gunzipSync(bytes);
  } else if (enc.includes("deflate")) {
    decoded = inflateSync(bytes);
  }
  return decoded.toString("utf8");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

export function toolKindsFromResponses(raw: string): Map<string, "function" | "custom"> {
  const kinds = new Map<string, "function" | "custom">();
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    parsed = object(value, "Responses 正文");
  } catch {
    return kinds;
  }
  parsed = codexChatTools(parsed).body;
  if (!Array.isArray(parsed.tools)) {
    return kinds;
  }
  for (const tool of parsed.tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const record = tool as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : record;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) {
      continue;
    }
    kinds.set(name, record.type === "custom" ? "custom" : "function");
  }
  return kinds;
}

function chatTool(tool: unknown): ChatTool | undefined {
  if (!tool || typeof tool !== "object") {
    return undefined;
  }
  const record = tool as Record<string, unknown>;
  if (record.type !== "function" && record.type !== "custom") {
    return undefined;
  }
  const fn =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : record;
  const name = typeof fn.name === "string" ? fn.name : "";
  if (!name) {
    return undefined;
  }
  return {
    type: "function",
    function: {
      name,
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      parameters:
        record.type === "custom"
          ? {
              type: "object",
              properties: {
                input: { type: "string", description: record.format ? `The tool input must follow this format definition: ${JSON.stringify(record.format)}` : "The tool input." },
              },
              required: ["input"],
            }
          : fn.parameters ?? { type: "object", properties: {} },
    },
  };
}

function chatContent(content: unknown): string | unknown[] {
  if (typeof content === "string") return content;
  const parts = list(content, "Responses content").map(part => {
    const value = object(part, "Responses content part");
    if (value.type === "input_text" || value.type === "output_text") {
      allowedFields(value, ["type", "text", "annotations"], "Responses text");
      if (Array.isArray(value.annotations) && value.annotations.length) throw new AdapterError("Chat 無法保留文字 annotations。");
      return { type: "text", text: string(value.text, "text") };
    }
    if (value.type === "input_image") {
      allowedFields(value, ["type", "image_url", "detail"], "Responses image");
      return { type: "image_url", image_url: { url: string(value.image_url, "image_url"), detail: value.detail ?? "auto" } };
    }
    throw new AdapterError(`Chat 無法轉換內容類型 ${String(value.type)}。`);
  });
  return parts.every(part => part.type === "text") ? parts.map(part => (part as { text: string }).text).join("") : parts;
}

function chatToolArguments(raw: string, custom: boolean): string {
  if (!raw) {
    return "{}";
  }
  if (!custom) {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return JSON.stringify({ input: raw });
    }
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { input?: unknown }).input === "string"
    ) {
      return raw;
    }
  } catch {
    // 腳本原文，包回模型看過的 input 欄。
  }
  return JSON.stringify({ input: raw });
}

function pushFunctionCall(
  messages: ChatMessage[],
  record: Record<string, unknown>,
): void {
  const id = typeof record.call_id === "string" ? record.call_id : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (!id || !name) {
    return;
  }
  const rawArguments =
    typeof record.arguments === "string" && record.arguments
      ? record.arguments
      : typeof record.input === "string"
        ? record.input
        : "";
  const call = {
    id,
    type: "function" as const,
    function: {
      name,
      arguments: chatToolArguments(rawArguments, record.type === "custom_tool_call"),
    },
  };
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.tool_calls) {
    last.tool_calls.push(call);
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [call] });
}
export function responsesToChatBody(raw: string, model: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    parsed = object(value, "Responses 正文");
  } catch {
    throw new AdapterError("Responses 正文必須是 JSON 物件。");
  }
  const source = normalizeCodexRequest(parsed);
  parsed = codexChatTools(source).body;
  const guidance = codexToolGuidance(source, Array.isArray(parsed.tools) ? parsed.tools.map(value => String(object(value, "tool").name)) : []);
  const options = codexChatOptions(parsed, chatResponseFormat);
  if (parsed.tools !== undefined) for (const tool of list(parsed.tools, "tools")) {
    const record = object(tool, "tool");
    if (record.type !== "function" && record.type !== "custom") throw new AdapterError(`Chat 無法轉換工具類型 ${String(record.type)}。`);
    allowedFields(record, record.type === "custom" ? ["type", "name", "description", "format"] : ["type", "name", "description", "parameters", "strict", "function"], "Chat tool");
    if (record.function) allowedFields(object(record.function, "function"), ["name", "description", "parameters", "strict"], "Chat function");
    const fn = record.function ? object(record.function, "function") : record;
    string(fn.name, "tool name");
    if (record.type === "custom" && record.format !== undefined) {
      const format = object(record.format, "custom format");
      if (format.type === "grammar") {
        allowedFields(format, ["type", "syntax", "definition"], "custom grammar");
        if (format.syntax !== "lark" && format.syntax !== "regex") throw new AdapterError("Chat 無法轉換此自訂 grammar syntax。");
        string(format.definition, "grammar definition");
      } else if (format.type === "text") allowedFields(format, ["type"], "custom format");
      else throw new AdapterError("Chat 無法轉換此自訂工具格式。");
    }
  }
  const messages: ChatMessage[] = [];
  if (typeof parsed.instructions === "string" && parsed.instructions) {
    messages.push({ role: "system", content: parsed.instructions });
  }
  const input = parsed.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const record = object(item, "Responses input item");
      if (record.type === "reasoning") {
        allowedFields(record, ["type", "id", "status", "summary", "content"], "Chat reasoning item");
        const summary = list(record.summary, "reasoning summary").map(value => {
          const part = object(value, "reasoning summary part");
          allowedFields(part, ["type", "text"], "reasoning summary part");
          if (part.type !== "summary_text") throw new AdapterError("Chat 無法轉換此 reasoning summary 類型。");
          return string(part.text, "reasoning summary text");
        }).join("") + (record.content === undefined ? "" : list(record.content, "reasoning content").map(value => {
          const part = object(value, "reasoning content part");
          allowedFields(part, ["type", "text"], "reasoning content part");
          if (part.type !== "reasoning_text") throw new AdapterError("Chat 無法轉換此 reasoning content 類型。");
          return string(part.text, "reasoning text");
        }).join(""));
        if (summary) messages.push({ role: "assistant", content: `<reasoning>\n${summary}\n</reasoning>` });
        continue;
      }
      if (record.type === "input_text" || record.type === "output_text") {
        allowedFields(record, ["type", "text"], "Responses text item");
        const text = string(record.text, "text");
        if (text) {
          messages.push({
            role: record.type === "output_text" ? "assistant" : "user",
            content: text,
          });
        }
        continue;
      }
      if (record.type === "function_call" || record.type === "custom_tool_call") {
        allowedFields(record, ["type", "id", "status", "call_id", "name", "arguments", "input"], "Responses tool call");
        if (!record.call_id || !record.name) throw new AdapterError("工具呼叫缺少 call_id 或 name。");
        pushFunctionCall(messages, record);
        continue;
      }
      if (
        record.type === "function_call_output" ||
        record.type === "custom_tool_call_output"
      ) {
        allowedFields(record, ["type", "id", "status", "call_id", "output"], "Responses tool output");
        const id = string(record.call_id, "call_id");
        const output = typeof record.output === "string" ? record.output : chatContent(record.output);
        if (id) {
          messages.push({ role: "tool", tool_call_id: id, content: output });
        }
        continue;
      }
      if (record.type !== "message" && typeof record.role !== "string") {
        throw new AdapterError(`Chat 無法轉換輸入類型 ${String(record.type)}。`);
      }
      if (!["assistant", "system", "developer", "user"].includes(String(record.role))) throw new AdapterError("Chat 無法轉換此 message role。");
      allowedFields(record, ["type", "id", "status", "role", "content"], "Responses message");
      const role =
        record.role === "assistant"
          ? "assistant"
          : record.role === "system" || record.role === "developer"
            ? "system"
            : "user";
      const content = chatContent(record.content);
      if (!content) {
        continue;
      }
      messages.push({ role, content });
    }
  }
  else if (input !== undefined) throw new AdapterError("Responses input 必須是文字或陣列。");
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.flatMap((tool) => {
        const converted = chatTool(tool);
        return converted ? [converted] : [];
      })
    : [];
  if (guidance.catalog) {
    const instructions = typeof parsed.instructions === "string" ? parsed.instructions : "";
    const guided = appendToolInstructions(instructions, [guidance.catalog]);
    if (instructions) messages[0] = { role: "system", content: guided };
    else messages.unshift({ role: "system", content: guided });
  }
  for (const tool of tools) if (guidance.execNames.has(tool.function.name)) {
    const parameters = object(tool.function.parameters, "parameters");
    const input = object(object(parameters.properties, "properties").input, "input");
    input.description = codeModeInputDescription(typeof input.description === "string" ? input.description : undefined);
  }
  return JSON.stringify({
    model,
    messages,
    stream: parsed.stream ?? true,
    ...options,
    ...(parsed.tool_choice !== undefined ? { tool_choice: chatToolChoice(parsed.tool_choice) } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  });
}

function chatToolChoice(value: unknown): unknown {
  if (typeof value === "string" && ["auto", "none", "required"].includes(value)) return value;
  const choice = object(value, "tool_choice");
  allowedFields(choice, ["type", "name"], "Chat tool_choice");
  if (choice.type === "function" || choice.type === "custom") return { type: "function", function: { name: string(choice.name, "tool_choice.name") } };
  throw new AdapterError("Chat 無法轉換 tool_choice。");
}

function chatResponseFormat(value: unknown): unknown {
  const format = object(value, "text.format");
  if (format.type === "text" || format.type === "json_object") {
    allowedFields(format, ["type"], "text.format"); return format;
  }
  if (format.type === "json_schema") {
    allowedFields(format, ["type", "name", "description", "schema", "strict"], "text.format");
    const { type, ...schema } = format;
    return { type, json_schema: schema };
  }
  throw new AdapterError("Chat 無法轉換 text.format。");
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 14);
}

function sse(name: string, sequence: number, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({
    type: name,
    sequence_number: sequence,
    ...data,
  })}\n\n`;
}

export class ResponsesSse {
  private reasoning = "";
  private reasoningIndex = -1;
  private readonly reasoningId = `rs_${randomId()}`;
  private finishReason: unknown;
  private usage: Record<string, unknown> | null = null;
  private sequence = 0;
  private opened = false;
  private textClosed = false;
  private text = "";
  private textIndex = 0;
  private nextIndex = 0;
  private readonly responseId = `resp_${randomId()}`;
  private readonly itemId = `msg_${randomId()}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private buffer = "";
  private readonly tools = new Map<
    number,
    {
      id: string;
      name: string;
      args: string;
      inputEmitted: string;
      itemId: string;
      outputIndex: number;
      started: boolean;
      custom: boolean;
    }
  >();

  constructor(
    private readonly model: string,
    private readonly toolKinds: ReadonlyMap<string, "function" | "custom"> = new Map(),
    private readonly toolIdentity: (name: string) => FreeformToolIdentity = name => ({ name }),
    private readonly hideReasoningSummary = false,
  ) {}

  created(): string {
    return this.frame("response.created", {
      response: this.snapshot("in_progress", []),
    });
  }

  pushChatChunk(chunk: string): string {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      out += this.pushChatLine(line);
    }
    return out;
  }

  finish(): string {
    if (this.buffer.trim()) {
      const tail = this.pushChatLine(this.buffer);
      this.buffer = "";
      return tail + this.completed();
    }
    return this.completed();
  }

  private pushChatLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return "";
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      return "";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "";
    }
    const choice = (
      parsed as {
        choices?: Array<{
          finish_reason?: unknown;
          delta?: {
            content?: unknown;
            reasoning?: unknown;
            reasoning_content?: unknown;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      }
    ).choices?.[0];
    if (choice?.finish_reason != null) this.finishReason = choice.finish_reason;
    const usage = (parsed as { usage?: Record<string, unknown> }).usage;
    if (usage) this.usage = { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 };
    let out = "";
    const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning) {
      if (this.reasoningIndex < 0) {
        this.reasoningIndex = this.nextIndex++;
        out += this.frame("response.output_item.added", { output_index: this.reasoningIndex, item: { type: "reasoning", id: this.reasoningId, summary: [], status: "in_progress" } });
        if (!this.hideReasoningSummary) out += this.frame("response.reasoning_summary_part.added", { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
      }
      this.reasoning += reasoning;
      if (!this.hideReasoningSummary) out += this.frame("response.reasoning_summary_text.delta", { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0, delta: reasoning });
    }
    const content = choice?.delta?.content;
    if (typeof content === "string" && content) {
      out += this.delta(content);
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      out += this.toolDelta(call);
    }
    return out;
  }

  private toolDelta(call: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): string {
    const index = call.index ?? 0;
    const byId = call.id
      ? [...this.tools.values()].find((tool) => tool.id === call.id)
      : undefined;
    let tool = byId ?? this.tools.get(index);
    if (!tool) {
      tool = {
        id: call.id || `call_${randomId()}`,
        name: "",
        args: "",
        inputEmitted: "",
        itemId: `fc_${randomId()}`,
        outputIndex: 0,
        started: false,
        custom: false,
      };
      this.tools.set(index, tool);
    }
    if (call.id) {
      tool.id = call.id;
    }
    if (call.function?.name) {
      tool.name = tool.name
        ? call.function.name.startsWith(tool.name)
          ? call.function.name
          : tool.name + call.function.name
        : call.function.name;
    }
    if (call.function?.arguments) {
      tool.args += call.function.arguments;
    }
    let out = "";
    if (!tool.started && tool.name) {
      tool.started = true;
      tool.custom = this.toolKinds.get(tool.name) === "custom";
      tool.outputIndex = this.nextIndex;
      this.nextIndex += 1;
      out += this.frame("response.output_item.added", {
        output_index: tool.outputIndex,
        item: tool.custom
          ? {
              type: "custom_tool_call",
              id: tool.itemId,
              call_id: tool.id,
              name: tool.name,
              input: "",
              status: "in_progress",
            }
          : {
              type: "function_call",
              id: tool.itemId,
              call_id: tool.id,
              name: tool.name,
              arguments: "",
              status: "in_progress",
            },
      });
    }
    if (
      tool.started &&
      !tool.custom &&
      call.function?.arguments &&
      toolCallArgumentsCouldBeJson(tool.args)
    ) {
      out += this.frame("response.function_call_arguments.delta", {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: call.function.arguments,
      });
    }
    if (tool.started && tool.custom) {
      const identity = this.toolIdentity(tool.name);
      const ownsGrammar = identity.namespace === undefined || identity.namespace === "functions";
      const full = progressiveFreeformInput(tool.args, ownsGrammar ? identity.name : "");
      if (full !== null) {
        const holdPatch =
          ownsGrammar && identity.name === "apply_patch" && mayBecomePatchEnvelope(full);
        if (
          !holdPatch &&
          full.startsWith(tool.inputEmitted) &&
          full.length > tool.inputEmitted.length
        ) {
          const delta = full.slice(tool.inputEmitted.length);
          tool.inputEmitted = full;
          out += this.frame("response.custom_tool_call_input.delta", {
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta,
          });
        }
      }
    }
    return out;
  }

  private delta(piece: string): string {
    let out = this.ensureOpen();
    this.text += piece;
    out += this.frame("response.output_text.delta", {
      item_id: this.itemId,
      output_index: this.textIndex,
      content_index: 0,
      delta: piece,
    });
    return out;
  }

  private ensureOpen(): string {
    if (this.opened) {
      return "";
    }
    this.opened = true;
    this.textIndex = this.nextIndex;
    this.nextIndex += 1;
    return (
      this.frame("response.output_item.added", {
        output_index: this.textIndex,
        item: {
          type: "message",
          id: this.itemId,
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }) +
      this.frame("response.content_part.added", {
        item_id: this.itemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      })
    );
  }

  private closeText(): string {
    if (!this.opened || this.textClosed) {
      return "";
    }
    this.textClosed = true;
    const item = {
      type: "message",
      id: this.itemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: this.text, annotations: [] }],
    };
    return (
      this.frame("response.output_text.done", {
        item_id: this.itemId,
        output_index: this.textIndex,
        content_index: 0,
        text: this.text,
      }) +
      this.frame("response.content_part.done", {
        item_id: this.itemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      }) +
      this.frame("response.output_item.done", {
        output_index: this.textIndex,
        item,
      })
    );
  }

  private closeTools(): { frames: string; items: unknown[]; failed: boolean } {
    let frames = "";
    const items: unknown[] = [];
    const seen = new Set<string>();
    for (const tool of this.tools.values()) {
      if (!tool.name || seen.has(tool.id)) {
        continue;
      }
      seen.add(tool.id);
      if (!tool.custom && !toolCallArgumentsUsable(tool.args)) {
        frames += this.frame("response.failed", {
          response: {
            ...this.snapshot("failed", items),
            error: {
              type: "upstream_error",
              message: "upstream stream produced malformed tool call arguments",
            },
          },
        });
        return { frames, items, failed: true };
      }
      const args = tool.custom
        ? repairFreeformToolInput(tool.args, this.toolIdentity(tool.name).name, this.toolIdentity(tool.name).namespace)
        : tool.args || "{}";
      const item = tool.custom
        ? {
            type: "custom_tool_call",
            id: tool.itemId,
            call_id: tool.id,
            name: tool.name,
            input: args,
            status: "completed",
          }
        : {
            type: "function_call",
            id: tool.itemId,
            call_id: tool.id,
            name: tool.name,
            arguments: args,
            status: "completed",
          };
      let framesForTool = "";
      if (!tool.started) {
        tool.custom = this.toolKinds.get(tool.name) === "custom";
        tool.outputIndex = this.nextIndex;
        this.nextIndex += 1;
        framesForTool += this.frame("response.output_item.added", {
          output_index: tool.outputIndex,
          item: tool.custom
            ? { ...item, status: "in_progress", input: "" }
            : { ...item, status: "in_progress", arguments: "" },
        });
      }
      framesForTool += this.frame(
        tool.custom
          ? "response.custom_tool_call_input.done"
          : "response.function_call_arguments.done",
        tool.custom
          ? {
              item_id: tool.itemId,
              output_index: tool.outputIndex,
              input: args,
            }
          : {
              item_id: tool.itemId,
              output_index: tool.outputIndex,
              arguments: args,
            },
      );
      framesForTool += this.frame("response.output_item.done", {
        output_index: tool.outputIndex,
        item,
      });
      frames += framesForTool;
      items.push(item);
    }
    return { frames, items, failed: false };
  }

  private completed(): string {
    const status = this.finishReason === "length" ? "incomplete" : "completed";
    const terminalEvent = status === "incomplete" ? "response.incomplete" : "response.completed";
    const textFrames = this.opened ? this.closeText() : "";
    const reasoningItem = { type: "reasoning", id: this.reasoningId, status: "completed", summary: this.hideReasoningSummary ? [] : [{ type: "summary_text", text: this.reasoning }],
      ...(this.hideReasoningSummary ? { content: [{ type: "reasoning_text", text: this.reasoning }] } : {}) };
    const reasoningFrames = this.reasoningIndex < 0 ? "" :
      (this.hideReasoningSummary ? "" : this.frame("response.reasoning_summary_text.done", { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0, text: this.reasoning }) +
      this.frame("response.reasoning_summary_part.done", { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0, part: reasoningItem.summary[0] })) +
      this.frame("response.output_item.done", { output_index: this.reasoningIndex, item: reasoningItem });
    const tools = this.closeTools();
    if (tools.failed) {
      return textFrames + tools.frames;
    }
    const output = [
      ...(this.reasoningIndex >= 0 ? [reasoningItem] : []),
      ...(this.opened
        ? [
            {
              type: "message",
              id: this.itemId,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: this.text, annotations: [] }],
            },
          ]
        : []),
      ...tools.items,
    ];
    const indexOf = (item: { id: string }): number => item.id === this.reasoningId ? this.reasoningIndex : item.id === this.itemId ? this.textIndex : [...this.tools.values()].find(tool => tool.itemId === item.id)?.outputIndex ?? 0;
    output.sort((left, right) => indexOf(left as { id: string }) - indexOf(right as { id: string }));
    if (output.length === 0) {
      return (
        this.ensureOpen() +
        this.closeText() +
        this.frame(terminalEvent, {
          response: this.snapshot(status, [
            {
              type: "message",
              id: this.itemId,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "", annotations: [] }],
            },
          ]),
        }) +
        "data: [DONE]\n\n"
      );
    }
    return (
      reasoningFrames +
      textFrames +
      tools.frames +
      this.frame(terminalEvent, {
        response: this.snapshot(status, output),
      }) +
      "data: [DONE]\n\n"
    );
  }

  private snapshot(status: string, output: unknown[]): Record<string, unknown> {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: this.usage,
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    };
  }

  private frame(name: string, data: Record<string, unknown>): string {
    const sequence = this.sequence;
    this.sequence += 1;
    return sse(name, sequence, data);
  }
}
