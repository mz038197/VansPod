import { allowedFields, list, object, string, AdapterError, type JsonObject } from "../adapters/types";
import { normalizeCodexRequest } from "./request";

/** Chat has flat tool names; keep an explicit mapping back to Codex namespaces. */
export function codexChatTools(raw: JsonObject): { body: JsonObject; restore: (item: JsonObject) => JsonObject } {
  const body = normalizeCodexRequest(raw);
  const identities = new Map<string, { name: string; namespace: string }>();
  const aliases = new Map<string, string>();
  const tools = body.tools === undefined ? [] : list(body.tools, "tools");
  const occupied = new Set(tools.map(value => object(value, "tool").name));
  const flattened = tools.flatMap(value => {
    const tool = object(value, "tool");
    if (tool.type !== "namespace") return [tool];
    allowedFields(tool, ["type", "name", "description", "tools"], "Chat namespace");
    const namespace = string(tool.name, "namespace");
    return list(tool.tools, "namespace tools").map(value => {
      const child = object(value, "namespace tool");
      if (child.type !== "function" && child.type !== "custom") throw new AdapterError("Chat 無法轉換此 namespace 工具。");
      const name = string(child.name, "tool name"), key = JSON.stringify([namespace, name]);
      if (aliases.has(key)) throw new AdapterError("Chat namespace 工具名稱重複。");
      let alias = `${namespace}__${name}`;
      if (alias.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(alias) || occupied.has(alias)) {
        let index = identities.size;
        do { alias = `vanspod_tool_${index++}`; } while (occupied.has(alias));
      }
      occupied.add(alias); aliases.set(key, alias); identities.set(alias, { name, namespace });
      return { ...child, name: alias, description: `${namespace}.${name}${tool.description ? ` (${tool.description})` : ""}${child.description ? `: ${child.description}` : ""}` };
    });
  });
  const translate = (value: JsonObject): JsonObject => {
    if (value.namespace === undefined) return value;
    const alias = aliases.get(JSON.stringify([value.namespace, value.name]));
    if (!alias) throw new AdapterError("Chat 無法找到此 namespace 工具的宣告。");
    const { namespace: _namespace, ...rest } = value;
    return { ...rest, name: alias };
  };
  return {
    body: { ...body, ...(body.tools !== undefined ? { tools: flattened } : {}),
      ...(Array.isArray(body.input) ? { input: body.input.map(value => {
        const item = object(value, "input item");
        return item.type === "function_call" || item.type === "custom_tool_call" ? translate(item) : item;
      }) } : {}),
      ...(body.tool_choice && typeof body.tool_choice === "object" ? { tool_choice: translate(object(body.tool_choice, "tool_choice")) } : {}),
    },
    restore(item) {
      if (item.type !== "function_call" && item.type !== "custom_tool_call") return item;
      const identity = typeof item.name === "string" ? identities.get(item.name) : undefined;
      return identity ? { ...item, ...identity } : item;
    },
  };
}

export function restoreChatToolEvent(data: JsonObject, restore: (item: JsonObject) => JsonObject): JsonObject {
  if (data.item) return { ...data, item: restore(object(data.item, "output item")) };
  if (data.response) return { ...data, response: restoreChatToolResponse(object(data.response, "response"), restore) };
  return data;
}

export function restoreChatToolResponse(body: JsonObject, restore: (item: JsonObject) => JsonObject): JsonObject {
  return Array.isArray(body.output) ? { ...body, output: body.output.map(value => restore(object(value, "output item"))) } : body;
}

export async function* restoreChatToolStream(source: AsyncGenerator<string>, restore: (item: JsonObject) => JsonObject): AsyncGenerator<string> {
  for await (const chunk of source) yield chunk.replace(/^data: (.+)$/gm, (line, raw: string) => raw === "[DONE]" ? line : `data: ${JSON.stringify(restoreChatToolEvent(object(JSON.parse(raw), "event"), restore))}`);
}
