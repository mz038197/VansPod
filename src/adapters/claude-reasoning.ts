import { AdapterError, object, type JsonObject } from "./types";

// Reasoning continuity for Claude Code on the Chat and Responses upstreams. Claude Code
// returns a thinking block unchanged on the next turn, so upstream reasoning is handed to it
// as a thinking block whose signature carries what the upstream needs to see again.
const PREFIX = "vpr1.";

/** What a thinking block carries: the Responses reasoning item, when there is one, and its text. */
export type Reasoning = { item?: JsonObject; text: string };

/** "off": the client did not ask for thinking. "hidden": it asked for it without the text. */
export type ThinkingMode = "off" | "hidden" | "shown";

export function thinkingMode(body: JsonObject): ThinkingMode {
  const thinking = body.thinking && typeof body.thinking === "object" ? body.thinking as JsonObject : {};
  if (thinking.type !== "enabled" && thinking.type !== "adaptive") return "off";
  return thinking.display === "omitted" ? "hidden" : "shown";
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(part => part && typeof part === "object" && typeof (part as JsonObject).text === "string" && (part as JsonObject).text ? [(part as JsonObject).text as string] : []) : [];
}

/** A Responses reasoning output item, reduced to the fields the upstream takes back as input. */
export function responsesReasoning(item: JsonObject): Reasoning | undefined {
  const text = [...texts(item.summary), ...texts(item.content)].join("\n\n");
  if (!text && typeof item.encrypted_content !== "string") return undefined;
  const kept: JsonObject = { type: "reasoning", summary: Array.isArray(item.summary) ? item.summary : [] };
  for (const key of ["id", "content", "encrypted_content"]) if (item[key] != null) kept[key] = item[key];
  return { item: kept, text };
}

export function thinkingBlock(reasoning: Reasoning, mode: ThinkingMode): JsonObject {
  return { type: "thinking", thinking: mode === "shown" ? reasoning.text : "", signature: PREFIX + Buffer.from(JSON.stringify(reasoning), "utf8").toString("base64url") };
}

/** Reads back a thinking block made by `thinkingBlock`. Any other signature cannot be replayed here. */
export function replayedReasoning(block: JsonObject): Reasoning {
  const signature = block.signature;
  if (block.type === "thinking" && typeof signature === "string" && signature.startsWith(PREFIX)) {
    try {
      const reasoning = object(JSON.parse(Buffer.from(signature.slice(PREFIX.length), "base64url").toString("utf8")), "reasoning");
      // The signature comes back from the client, so only a reasoning item's own fields reach the upstream.
      const item = reasoning.item === undefined ? undefined : object(reasoning.item, "reasoning item");
      if (item && item.type !== "reasoning") throw new Error("not a reasoning item");
      const kept = item && responsesReasoning(item)?.item;
      return { text: typeof reasoning.text === "string" ? reasoning.text : "", ...(kept ? { item: kept } : {}) };
    } catch { throw new AdapterError("Claude thinking 的回放資料已損毀。"); }
  }
  // Replaying it needs its Anthropic signature; dropping it would silently change the transcript.
  throw new AdapterError(`所選上游協定無法轉換 Claude 內容 ${String(block.type)}。`);
}
