import { codexToolGuidance, appendToolInstructions, codeModeInputDescription, CODE_MODE_RESULT_ECHO_SENTENCE, CODE_MODE_HOST_CONTRACT_SENTENCE } from "./tool-guidance";
import { allowedFields, list, object, string, type JsonObject } from "../adapters/types";

/** Move Codex's inline tool catalog into the standard Responses tools field. */
export function normalizeCodexRequest(body: JsonObject): JsonObject {
  if (!Array.isArray(body.input)) return body;
  const tools = body.tools === undefined ? [] : [...list(body.tools, "tools")];
  const input: unknown[] = [];
  let changed = false;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || (item as JsonObject).type !== "additional_tools") {
      input.push(item);
      continue;
    }
    const group = object(item, "additional_tools");
    allowedFields(group, ["type", "id", "role", "tools"], "additional_tools");
    tools.push(...list(group.tools, "additional_tools.tools"));
    changed = true;
  }
  return changed ? { ...body, input, tools } : body;
}

/** Router's Responses input accepts function history, so lower freeform tools
 * consistently across declarations, selectors, calls and paired results. */
export function codexResponsesUpstreamBody(body: JsonObject): JsonObject {
  // This Codex private account selector is not part of the Router's Responses
  // contract. Other unknown fields remain intact for upstream extensions.
  const { access_programs: _accessPrograms, ...publicBody } = body;
  const guidance = codexToolGuidance(body);
  const tool = (value: unknown, namespace?: string): JsonObject => {
    const record = object(value, "tool");
    if (record.type === "namespace") return { ...record, tools: list(record.tools, "namespace tools").map(value => tool(value, String(record.name))) };
    if (record.type !== "custom") return record;
    const { format, ...rest } = record;
    const codeMode = guidance.codeMode && record.name === "exec" && (namespace === undefined || namespace === "functions");
    const description = `Raw input for ${String(record.name)}.${format === undefined ? "" : ` The input must follow this format definition: ${JSON.stringify(format)}`}`;
    return { ...rest, type: "function", parameters: { type: "object", properties: { input: {
      type: "string", description: codeMode ? codeModeInputDescription(description) : description,
    } }, required: ["input"], additionalProperties: false } };
  };
  const choice = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const record = object(value, "tool_choice");
    if (record.type === "custom") return { ...record, type: "function" };
    if (record.type === "allowed_tools") return { ...record, tools: list(record.tools, "allowed tools").map(choice) };
    return record;
  };
  return { ...publicBody,
    ...(guidance.codeMode ? { instructions: appendToolInstructions(typeof body.instructions === "string" ? body.instructions : "", [CODE_MODE_RESULT_ECHO_SENTENCE, CODE_MODE_HOST_CONTRACT_SENTENCE]) } : {}),
    ...(body.tools === undefined ? {} : { tools: list(body.tools, "tools").map(value => tool(value)) }),
    ...(body.tool_choice === undefined ? {} : { tool_choice: choice(body.tool_choice) }),
    ...(Array.isArray(body.input) ? { input: body.input.map(value => {
      const item = object(value, "input item");
      if (item.type === "custom_tool_call") {
        const { input, id: _id, ...rest } = item;
        return { ...rest, type: "function_call", arguments: JSON.stringify({ input: string(input, "custom tool input") }) };
      }
      if (item.type === "custom_tool_call_output") {
        const { id: _id, ...rest } = item;
        return { ...rest, type: "function_call_output" };
      }
      return item;
    }) } : {}),
  };
}
