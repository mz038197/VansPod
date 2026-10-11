import { AdapterError, allowedFields, list, object, type JsonObject } from "../adapters/types";

// Build Chat options by projection, as opposed to validating the whole client
// envelope. Codex may add private transport fields (such as access_programs);
// those are not model options and must neither reject the turn nor reach Chat.
const DIRECT_FIELDS = ["temperature", "top_p", "parallel_tool_calls", "store", "metadata", "user", "stream_options", "prompt_cache_key", "prompt_cache_retention", "safety_identifier", "service_tier", "stop", "presence_penalty", "frequency_penalty"];

export function codexChatOptions(body: JsonObject, responseFormat: (value: unknown) => unknown): JsonObject {
  // Explicitly reject known semantic features that this adapter cannot retain.
  // Content, tool declarations and reasoning have their own strict validation.
  for (const key of ["prompt", "context_management", "audio", "modalities", "prediction", "max_tool_calls", "logprobs", "top_logprobs"]) if (body[key] != null) throw new AdapterError(`Chat 無法保留 ${key} 的請求語意。`);
  for (const key of ["previous_response_id", "conversation"]) if (body[key] != null) throw new AdapterError(`Chat 無法恢復 ${key}；請傳送完整 input 歷史。`);
  if (body.background != null && body.background !== false) throw new AdapterError("Chat 無法轉換背景執行請求。");
  if (body.truncation != null && body.truncation !== "disabled") throw new AdapterError("Chat 無法保留自動截斷 input 的設定。");
  if (body.include !== undefined) for (const include of list(body.include, "include")) {
    // Chat has no encrypted reasoning to include; this only requests optional
    // output. Replayed encrypted_content in input is skipped as opaque.
    if (include !== "reasoning.encrypted_content") throw new AdapterError(`Chat 無法轉換 include 選項 ${String(include)}。`);
  }
  const fields: JsonObject = Object.fromEntries(DIRECT_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  if (body.max_output_tokens !== undefined) fields.max_completion_tokens = body.max_output_tokens;
  if (body.reasoning !== undefined) {
    const reasoning = object(body.reasoning, "reasoning");
    // Match opencodex's reasoning-config projection: context and future
    // config extensions are not Chat options. Input reasoning items are
    // handled separately when the input history is converted.
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
