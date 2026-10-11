import { repairFreeformToolInput } from "./apply-patch-envelope";
import { AdapterError, list, object, string, type JsonObject } from "../adapters/types";

type ToolIdentity = { name: string; namespace?: string; custom: boolean };

/** Restore only tools explicitly declared as freeform in the client's request. */
export class CodexResponsesTools {
  private readonly tools: ToolIdentity[] = [];
  private readonly calls = new Map<string, { item: JsonObject; args: string; finished: boolean }>();

  constructor(body: JsonObject) {
    const collect = (tools: unknown[], namespace?: string): void => {
      for (const raw of tools) {
        const tool = object(raw, "tool");
        if (tool.type === "namespace") collect(list(tool.tools, "namespace tools"), string(tool.name, "namespace"));
        else if (tool.type === "function" || tool.type === "custom") {
          const name = string(tool.name, "tool name");
          if (this.tools.some(tool => tool.name === name && tool.namespace === namespace)) throw new AdapterError("Responses 工具宣告的 namespace/name 識別重複。");
          this.tools.push({ name, namespace, custom: tool.type === "custom" });
        }
      }
    };
    if (body.tools !== undefined) collect(list(body.tools, "tools"));
  }

  get hasCustomTools(): boolean { return this.tools.some(tool => tool.custom); }

  private identity(item: JsonObject): ToolIdentity | undefined {
    if ((item.type !== "function_call" && item.type !== "custom_tool_call") || typeof item.name !== "string") return;
    let matches = this.tools.filter(tool => tool.name === item.name && tool.namespace === item.namespace);
    if (!matches.length && item.namespace === undefined) matches = this.tools.filter(tool =>
      tool.name === item.name || (tool.namespace && `${tool.namespace}.${tool.name}` === item.name));
    if (matches.length > 1) throw new AdapterError("上游工具識別不明確；缺少可唯一判定的 namespace。", 502);
    return matches.length === 1 && matches[0].custom ? matches[0] : undefined;
  }

  private convertItem(value: unknown): unknown {
    const item = object(value, "Responses output item");
    const tool = this.identity(item);
    if (!tool) return item;
    const { arguments: args, input, ...rest } = item;
    return { ...rest, type: "custom_tool_call", name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}), input: repairFreeformToolInput(string(item.type === "custom_tool_call" ? input : args, "tool input"), tool.name, tool.namespace) };
  }

  response(body: JsonObject): JsonObject {
    return Array.isArray(body.output) ? { ...body, output: body.output.map(item => this.convertItem(item)) } : body;
  }

  events(data: JsonObject): JsonObject[] {
    if (data.type === "response.output_item.added") {
      const item = object(data.item, "output item");
      if (this.identity(item)) {
        this.calls.set(string(item.id, "item id"), { item, args: typeof (item.arguments ?? item.input) === "string" ? String(item.arguments ?? item.input) : "", finished: false });
        return [{ ...data, item: this.convertItem({ ...item, arguments: "", input: "" }) }];
      }
    }
    const state = typeof data.item_id === "string" ? this.calls.get(data.item_id) : undefined;
    if (state && (data.type === "response.function_call_arguments.delta" || data.type === "response.custom_tool_call_input.delta")) {
      state.args += string(data.delta, "arguments delta");
      return []; // Hold the JSON wrapper until the complete freeform input is known.
    }
    if (state && (data.type === "response.function_call_arguments.done" || data.type === "response.custom_tool_call_input.done")) {
      const input = (this.convertItem({ ...state.item, arguments: data.arguments ?? state.args, input: data.input ?? state.args }) as JsonObject).input;
      state.finished = true;
      const { arguments: _args, input: _input, ...rest } = data;
      return [{ ...rest, type: "response.custom_tool_call_input.delta", delta: input },
        { ...rest, type: "response.custom_tool_call_input.done", input }];
    }
    if (data.type === "response.output_item.done") {
      const item = object(data.item, "output item"), converted = this.convertItem(item);
      if (converted !== item) {
        const state = typeof item.id === "string" ? this.calls.get(item.id) : undefined;
        const prefix = state?.finished ? [] : [
          { type: "response.custom_tool_call_input.delta", item_id: item.id, output_index: data.output_index, delta: (converted as JsonObject).input },
          { type: "response.custom_tool_call_input.done", item_id: item.id, output_index: data.output_index, input: (converted as JsonObject).input },
        ];
        if (state) state.finished = true;
        return [...prefix, { ...data, item: converted }];
      }
    }
    if ((data.type === "response.completed" || data.type === "response.incomplete") && data.response) return [{ ...data, response: this.response(object(data.response, "response")) }];
    return [data];
  }
}
