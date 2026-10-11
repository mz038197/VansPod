import { AdapterError, allowedFields, list, object, type JsonObject } from "../adapters/types";

// Classify the Responses envelope separately from the Chat fields we serialize.
// Client metadata is opaque bookkeeping: do not inspect its keys or send it to a model.
const CLIENT_FIELDS = ["client_metadata", "include"];
const CONTENT_FIELDS = ["model", "input", "instructions", "tools", "tool_choice", "stream"];
const DIRECT_FIELDS = ["temperature", "top_p", "parallel_tool_calls", "store", "metadata", "user", "stream_options", "prompt_cache_key", "prompt_cache_retention", "safety_identifier", "service_tier", "stop", "presence_penalty", "frequency_penalty"];

export function codexChatOptions(body: JsonObject, responseFormat: (value: unknown) => unknown): JsonObject {
  allowedFields(body, [...CONTENT_FIELDS, ...CLIENT_FIELDS, ...DIRECT_FIELDS, "max_output_tokens", "reasoning", "text", "background", "truncation", "previous_response_id", "conversation"], "Responses → Chat");
  for (const key of ["previous_response_id", "conversation"]) if (body[key] != null) throw new AdapterError(`Chat 無法恢復 ${key}；請傳送完整 input 歷史。`);
  if (body.background != null && body.background !== false) throw new AdapterError("Chat 無法轉換背景執行請求。");
  if (body.truncation != null && body.truncation !== "disabled") throw new AdapterError("Chat 無法保留自動截斷 input 的設定。");
  if (body.include !== undefined) for (const include of list(body.include, "include")) {
    // Chat has no encrypted reasoning to include; this requests optional output,
    // unlike encrypted_content in input, which must still fail rather than vanish.
    if (include !== "reasoning.encrypted_content") throw new AdapterError(`Chat 無法轉換 include 選項 ${String(include)}。`);
  }
  const fields: JsonObject = Object.fromEntries(DIRECT_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  if (body.max_output_tokens !== undefined) fields.max_completion_tokens = body.max_output_tokens;
  if (body.reasoning !== undefined) {
    const reasoning = object(body.reasoning, "reasoning");
    allowedFields(reasoning, ["effort", "summary"], "Chat reasoning");
    if (reasoning.summary != null && !["auto", "concise", "detailed", "none"].includes(String(reasoning.summary))) throw new AdapterError("Chat 無法轉換此 reasoning summary 設定。");
    if (reasoning.effort !== undefined) fields.reasoning_effort = reasoning.effort === "ultra" ? "max" : reasoning.effort;
  }
  if (body.text !== undefined) {
    const text = object(body.text, "text");
    allowedFields(text, ["format", "verbosity"], "Chat text");
    if (text.format !== undefined) fields.response_format = responseFormat(text.format);
    if (text.verbosity !== undefined) fields.verbosity = text.verbosity;
  }
  return fields;
}
