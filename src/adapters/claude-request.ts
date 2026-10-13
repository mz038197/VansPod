import { createHash } from "node:crypto";
import { AdapterError, list, object, string, type JsonObject } from "./types";
import { replayedReasoning, thinkingMode } from "./claude-reasoning";

// Only recognized fields and content types are read. Unknown ones are not forwarded
// and do not block the request, so a new Claude Code field cannot break every turn.

function imageUrl(block: JsonObject): string {
  const source = object(block.source, "image.source");
  if (source.type === "url") return string(source.url, "image URL");
  if (source.type === "base64") return `data:${string(source.media_type, "media_type")};base64,${string(source.data, "image data")}`;
  throw new AdapterError("無法轉換此圖片 source。");
}

function contentBlocks(content: unknown): JsonObject[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return list(content, "Claude content").map(value => object(value, "Claude content block"));
}

const TOOL_ERROR = "[tool error]";

function result(block: JsonObject, wire: "chat" | "responses"): unknown {
  // The error marker has no equivalent on these upstream protocols; carry it as text, never hide it.
  const failed = block.is_error === true;
  if (block.content === undefined) return failed ? TOOL_ERROR : "";
  if (typeof block.content === "string") return failed ? `${TOOL_ERROR} ${block.content}` : block.content;
  const parts = contentBlocks(block.content).flatMap(value => part(value, wire, "user"));
  return failed ? [{ type: wire === "chat" ? "text" : "input_text", text: TOOL_ERROR }, ...parts] : parts;
}

function part(block: JsonObject, wire: "chat" | "responses", role: string): JsonObject[] {
  if (block.type === "text") return [{ type: wire === "chat" ? "text" : role === "assistant" ? "output_text" : "input_text", text: string(block.text, "text") }];
  if (block.type === "image" && role === "user") {
    const url = imageUrl(block);
    return [wire === "chat" ? { type: "image_url", image_url: { url } } : { type: "input_image", image_url: url }];
  }
  if (block.type === "thinking" || block.type === "redacted_thinking") replayedReasoning(block);
  return [];
}

function options(body: JsonObject, wire: "chat" | "responses"): JsonObject {
  const output: JsonObject = { stream: body.stream === true };
  for (const key of ["temperature", "top_p"]) if (body[key] !== undefined) output[key] = body[key];
  if (body.max_tokens !== undefined) output[wire === "chat" ? "max_tokens" : "max_output_tokens"] = body.max_tokens;
  if (wire === "chat" && body.stop_sequences !== undefined) output.stop = body.stop_sequences;
  if (body.metadata !== undefined) {
    // Claude Code's user_id is a JSON blob; OpenAI-style upstreams reject user longer than 64 characters.
    const user = object(body.metadata, "metadata").user_id;
    output.user = typeof user === "string" && user.length > 64 ? createHash("sha256").update(user).digest("hex") : user;
  }
  // thinking and context_management have no upstream equivalent. Reasoning depth travels as
  // effort; the budget is never forwarded raw and only picks the tier when no effort is given.
  const thinking = body.thinking === undefined ? {} : object(body.thinking, "thinking");
  const effort = body.output_config !== undefined ? object(body.output_config, "output_config").effort
    : thinking.type === "enabled" && typeof thinking.budget_tokens === "number" ? thinking.budget_tokens <= 4096 ? "low" : thinking.budget_tokens <= 16384 ? "medium" : "high" : undefined;
  if (effort !== undefined) {
    if (wire === "chat") output.reasoning_effort = effort;
    else output.reasoning = { effort };
  }
  const mode = thinkingMode(body);
  if (wire === "responses" && mode !== "off") {
    // Encrypted reasoning is what a stateless upstream needs back on the next turn.
    output.include = ["reasoning.encrypted_content"];
    if (mode === "shown") output.reasoning = { ...object(output.reasoning ?? {}, "reasoning"), summary: "auto" };
  }
  if (body.tools !== undefined) output.tools = list(body.tools, "tools").map(value => {
    const tool = object(value, "Claude tool");
    const fn = { name: string(tool.name, "tool name"), ...(tool.description !== undefined ? { description: tool.description } : {}),
      // Responses reads an omitted strict as strict mode, which turns optional parameters into required ones.
      ...(tool.strict !== undefined ? { strict: tool.strict } : wire === "responses" ? { strict: false } : {}), parameters: object(tool.input_schema, "input_schema") };
    return wire === "chat" ? { type: "function", function: fn } : { type: "function", ...fn };
  });
  if (body.tool_choice !== undefined) {
    const choice = object(body.tool_choice, "tool_choice");
    if (choice.disable_parallel_tool_use !== undefined) output.parallel_tool_calls = !choice.disable_parallel_tool_use;
    if (choice.type === "tool") output.tool_choice = wire === "chat" ? { type: "function", function: { name: string(choice.name, "tool name") } } : { type: "function", name: string(choice.name, "tool name") };
    else if (choice.type === "any") output.tool_choice = "required";
    else if (choice.type === "auto" || choice.type === "none") output.tool_choice = choice.type;
    else throw new AdapterError("無法轉換 Claude tool_choice。");
  }
  return output;
}

// Claude Code sends mid-conversation system messages. They keep their place in the timeline;
// Responses takes them as developer because some backends refuse system items in input.
const ROLES = ["user", "assistant", "system"];

// Claude Code opens the system prompt with a per-request billing line that is not a model instruction.
function system(value: unknown): string {
  return contentBlocks(value).flatMap(block => block.type === "text" ? [string(block.text, "text")] : []).join("\n").replace(/^x-anthropic-billing-header:[^\n]*\n*/, "");
}

export function claudeToResponses(body: JsonObject, model: string): JsonObject {
  if (body.stop_sequences !== undefined) throw new AdapterError("Responses 無法表達 Claude stop_sequences。");
  const input: JsonObject[] = [];
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "Claude message");
    const role = string(message.role, "role");
    if (!ROLES.includes(role)) throw new AdapterError("Claude message role 無法轉換。");
    let parts: JsonObject[] = [];
    const flush = () => { if (parts.length) input.push({ role: role === "system" ? "developer" : role, content: parts }); parts = []; };
    for (const block of contentBlocks(message.content)) {
      if (block.type === "thinking" && role === "assistant") {
        // Chat reasoning has no Responses item to hand back, so only the item form is replayed.
        const { item } = replayedReasoning(block);
        if (item) { flush(); input.push(item); }
      } else if (block.type === "tool_use" && role === "assistant") {
        flush();
        input.push({ type: "function_call", call_id: string(block.id, "tool id"), name: string(block.name, "tool name"), arguments: JSON.stringify(object(block.input, "tool input")) });
      } else if (block.type === "tool_result" && role === "user") {
        flush(); input.push({ type: "function_call_output", call_id: string(block.tool_use_id, "tool_use_id"), output: result(block, "responses") });
      } else parts.push(...part(block, "responses", role));
    }
    flush();
  }
  const instructions = body.system === undefined ? "" : system(body.system);
  return { model, input, store: false, ...options(body, "responses"), ...(instructions ? { instructions } : {}) };
}

export function claudeToChat(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = [];
  const instructions = body.system === undefined ? "" : system(body.system);
  if (instructions) messages.push({ role: "system", content: instructions });
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "Claude message");
    const role = string(message.role, "role");
    if (!ROLES.includes(role)) throw new AdapterError("Claude message role 無法轉換。");
    let parts: JsonObject[] = [], calls: JsonObject[] = [], reasoning: string[] = [];
    const flush = () => {
      if (parts.length || calls.length) messages.push({ role, content: parts.length ? parts.every(p => p.type === "text") ? parts.map(p => p.text).join("") : parts : null,
        ...(reasoning.length ? { reasoning_content: reasoning.join("\n\n") } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
      parts = []; calls = []; reasoning = [];
    };
    for (const block of contentBlocks(message.content)) {
      if (block.type === "thinking" && role === "assistant") {
        const { text } = replayedReasoning(block);
        if (text) reasoning.push(text);
      } else if (block.type === "tool_use" && role === "assistant") {
        calls.push({ id: string(block.id, "tool id"), type: "function", function: { name: string(block.name, "tool name"), arguments: JSON.stringify(object(block.input, "tool input")) } });
      } else if (block.type === "tool_result" && role === "user") {
        flush(); messages.push({ role: "tool", tool_call_id: string(block.tool_use_id, "tool_use_id"), content: result(block, "chat") });
      } else parts.push(...part(block, "chat", role));
    }
    flush();
  }
  return { model, messages, ...options(body, "chat") };
}
