import { AdapterError, allowedFields, list, object, string, type JsonObject } from "./types";

function imageUrl(block: JsonObject): string {
  allowedFields(block, ["type", "source"], "Claude image");
  const source = object(block.source, "image.source");
  if (source.type === "url") { allowedFields(source, ["type", "url"], "image source"); return string(source.url, "image URL"); }
  if (source.type === "base64") {
    allowedFields(source, ["type", "media_type", "data"], "image source");
    return `data:${string(source.media_type, "media_type")};base64,${string(source.data, "image data")}`;
  }
  throw new AdapterError("無法轉換此圖片 source。");
}

function contentBlocks(content: unknown): JsonObject[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return list(content, "Claude content").map(value => object(value, "Claude content block"));
}

function text(block: JsonObject): string {
  allowedFields(block, ["type", "text"], "Claude text");
  return string(block.text, "text");
}

function result(block: JsonObject, wire: "chat" | "responses"): unknown {
  allowedFields(block, ["type", "tool_use_id", "content", "is_error"], "Claude tool result");
  // The error marker has no equivalent on these upstream protocols; never hide it.
  if (block.is_error === true) throw new AdapterError("所選上游協定無法保留 tool_result.is_error。");
  if (block.content === undefined) return "";
  if (typeof block.content === "string") return block.content;
  return contentBlocks(block.content).map(value => part(value, wire, "user"));
}

function part(block: JsonObject, wire: "chat" | "responses", role: string): JsonObject {
  if (block.type === "text") return { type: wire === "chat" ? "text" : role === "assistant" ? "output_text" : "input_text", text: text(block) };
  if (block.type === "image" && role === "user") {
    const url = imageUrl(block);
    return wire === "chat" ? { type: "image_url", image_url: { url } } : { type: "input_image", image_url: url };
  }
  throw new AdapterError(`所選上游協定無法轉換 Claude 內容 ${String(block.type)}。`);
}

function validate(body: JsonObject, wire: "chat" | "responses"): void {
  allowedFields(body, ["model", "messages", "system", "max_tokens", "stream", "tools", "tool_choice", "temperature", "top_p", "stop_sequences", "metadata", "thinking", "output_config"], `Claude → ${wire}`);
  if (body.thinking !== undefined) {
    const thinking = object(body.thinking, "thinking");
    allowedFields(thinking, ["type"], "thinking");
    if (thinking.type !== "disabled") throw new AdapterError("跨協定轉換無法保證 Claude thinking 的語意，請停用或使用 Messages adapter。");
  }
  if (body.output_config !== undefined) {
    const config = object(body.output_config, "output_config");
    allowedFields(config, ["effort"], "output_config");
  }
  if (wire === "responses" && body.stop_sequences !== undefined) throw new AdapterError("Responses 無法表達 Claude stop_sequences。");
  if (body.metadata !== undefined) allowedFields(object(body.metadata, "metadata"), ["user_id"], "Claude metadata");
}

function options(body: JsonObject, wire: "chat" | "responses"): JsonObject {
  const output: JsonObject = { stream: body.stream === true };
  for (const key of ["temperature", "top_p"]) if (body[key] !== undefined) output[key] = body[key];
  if (body.max_tokens !== undefined) output[wire === "chat" ? "max_tokens" : "max_output_tokens"] = body.max_tokens;
  if (wire === "chat" && body.stop_sequences !== undefined) output.stop = body.stop_sequences;
  if (body.metadata !== undefined) output.user = object(body.metadata, "metadata").user_id;
  if (body.output_config !== undefined) {
    const effort = object(body.output_config, "output_config").effort;
    if (wire === "chat") output.reasoning_effort = effort;
    else output.reasoning = { effort };
  }
  if (body.tools !== undefined) output.tools = list(body.tools, "tools").map(value => {
    const tool = object(value, "Claude tool");
    allowedFields(tool, ["name", "description", "input_schema", "strict"], "Claude tool");
    const fn = { name: string(tool.name, "tool name"), ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}), parameters: object(tool.input_schema, "input_schema") };
    return wire === "chat" ? { type: "function", function: fn } : { type: "function", ...fn };
  });
  if (body.tool_choice !== undefined) {
    const choice = object(body.tool_choice, "tool_choice");
    allowedFields(choice, ["type", "name", "disable_parallel_tool_use"], "Claude tool_choice");
    if (choice.disable_parallel_tool_use !== undefined) output.parallel_tool_calls = !choice.disable_parallel_tool_use;
    if (choice.type === "tool") output.tool_choice = wire === "chat" ? { type: "function", function: { name: string(choice.name, "tool name") } } : { type: "function", name: string(choice.name, "tool name") };
    else if (choice.type === "any") output.tool_choice = "required";
    else if (choice.type === "auto" || choice.type === "none") output.tool_choice = choice.type;
    else throw new AdapterError("無法轉換 Claude tool_choice。");
  }
  return output;
}

export function claudeToResponses(body: JsonObject, model: string): JsonObject {
  validate(body, "responses");
  const input: JsonObject[] = [];
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "Claude message");
    allowedFields(message, ["role", "content"], "Claude message");
    const role = string(message.role, "role");
    if (role !== "user" && role !== "assistant") throw new AdapterError("Claude message role 無法轉換。");
    let parts: JsonObject[] = [];
    const flush = () => { if (parts.length) input.push({ role, content: parts }); parts = []; };
    for (const block of contentBlocks(message.content)) {
      if (block.type === "tool_use" && role === "assistant") {
        flush(); allowedFields(block, ["type", "id", "name", "input"], "Claude tool use");
        input.push({ type: "function_call", call_id: string(block.id, "tool id"), name: string(block.name, "tool name"), arguments: JSON.stringify(object(block.input, "tool input")) });
      } else if (block.type === "tool_result" && role === "user") {
        flush(); input.push({ type: "function_call_output", call_id: string(block.tool_use_id, "tool_use_id"), output: result(block, "responses") });
      } else parts.push(part(block, "responses", role));
    }
    flush();
  }
  return { model, input, ...options(body, "responses"), ...(body.system !== undefined ? { instructions: contentBlocks(body.system).map(text).join("\n") } : {}) };
}

export function claudeToChat(body: JsonObject, model: string): JsonObject {
  validate(body, "chat");
  const messages: JsonObject[] = [];
  if (body.system !== undefined) messages.push({ role: "system", content: contentBlocks(body.system).map(text).join("\n") });
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "Claude message"); allowedFields(message, ["role", "content"], "Claude message");
    const role = string(message.role, "role");
    if (role !== "user" && role !== "assistant") throw new AdapterError("Claude message role 無法轉換。");
    let parts: JsonObject[] = [], calls: JsonObject[] = [];
    const flush = () => {
      if (parts.length || calls.length) messages.push({ role, content: parts.length ? parts.every(p => p.type === "text") ? parts.map(p => p.text).join("") : parts : null, ...(calls.length ? { tool_calls: calls } : {}) });
      parts = []; calls = [];
    };
    for (const block of contentBlocks(message.content)) {
      if (block.type === "tool_use" && role === "assistant") {
        allowedFields(block, ["type", "id", "name", "input"], "Claude tool use");
        calls.push({ id: string(block.id, "tool id"), type: "function", function: { name: string(block.name, "tool name"), arguments: JSON.stringify(object(block.input, "tool input")) } });
      } else if (block.type === "tool_result" && role === "user") {
        flush(); messages.push({ role: "tool", tool_call_id: string(block.tool_use_id, "tool_use_id"), content: result(block, "chat") });
      } else parts.push(part(block, "chat", role));
    }
    flush();
  }
  return { model, messages, ...options(body, "chat") };
}
