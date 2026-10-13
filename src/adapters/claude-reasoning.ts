import { AdapterError, list, object, type AdapterRequest, type JsonObject } from "./types";
import { upstreamRequest } from "./transport";

// Reasoning continuity for Claude Code on the Chat and Responses upstreams. Claude Code
// returns a thinking block unchanged on the next turn, so upstream reasoning is handed to it
// as a thinking block whose signature carries what the upstream needs to see again.
const PREFIX = "vpr1.";

/** What a thinking block carries: the Responses reasoning item, when there is one, its text, and the model that produced it. */
export type Reasoning = { item?: JsonObject; text: string; model?: string };

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

export function thinkingBlock(reasoning: Reasoning, mode: ThinkingMode, model: string): JsonObject {
  // An item already holds its text, so the text is only stored when there is no item.
  const carried = reasoning.item ? { model, item: reasoning.item } : { model, text: reasoning.text };
  return { type: "thinking", thinking: mode === "shown" ? reasoning.text : "", signature: PREFIX + Buffer.from(JSON.stringify(carried), "utf8").toString("base64url") };
}

/** Reads back a thinking block made by `thinkingBlock`. Any other signature cannot be replayed here. */
export function replayedReasoning(block: JsonObject): Reasoning {
  const signature = block.signature;
  if (block.type === "thinking" && typeof signature === "string" && signature.startsWith(PREFIX)) {
    try {
      const carried = object(JSON.parse(Buffer.from(signature.slice(PREFIX.length), "base64url").toString("utf8")), "reasoning");
      // The signature comes back from the client, so only a reasoning item's own fields reach the upstream.
      const item = carried.item === undefined ? undefined : object(carried.item, "reasoning item");
      if (item && item.type !== "reasoning") throw new Error("not a reasoning item");
      const kept = item && responsesReasoning(item);
      return { text: typeof carried.text === "string" ? carried.text : kept?.text ?? "", ...(kept ? { item: kept.item } : {}), ...(typeof carried.model === "string" ? { model: carried.model } : {}) };
    } catch { throw new AdapterError("Claude thinking 的回放資料已損毀。"); }
  }
  // Replaying it needs its Anthropic signature; dropping it would silently change the transcript.
  throw new AdapterError(`所選上游協定無法轉換 Claude 內容 ${String(block.type)}。`);
}

/** A Messages request without the thinking blocks made here, whose signatures an Anthropic upstream would reject. */
export function withoutReplayedThinking(body: JsonObject): JsonObject {
  if (!Array.isArray(body.messages)) return body;
  const replayed = (block: unknown) => !!block && typeof block === "object" && (block as JsonObject).type === "thinking" && String((block as JsonObject).signature).startsWith(PREFIX);
  const messages = (body.messages as JsonObject[]).flatMap(message => {
    if (!message || !Array.isArray(message.content) || !message.content.some(replayed)) return [message];
    const content = message.content.filter(block => !replayed(block));
    return content.length ? [{ ...message, content }] : [];
  });
  return { ...body, messages };
}

/** The upstream request without anything reasoning replay put in it, or undefined when there is nothing to take out. */
function withoutReasoning(body: JsonObject): JsonObject | undefined {
  const plain: JsonObject = { ...body };
  let changed = false;
  if (Array.isArray(plain.input)) {
    const input = list(plain.input, "input").filter(item => object(item, "input item").type !== "reasoning");
    if (input.length !== plain.input.length) { plain.input = input; changed = true; }
  }
  if (Array.isArray(plain.messages) && plain.messages.some(message => object(message, "message").reasoning_content !== undefined)) {
    plain.messages = plain.messages.map(message => { const { reasoning_content: _, ...rest } = object(message, "message"); return rest; });
    changed = true;
  }
  if (plain.include !== undefined) { delete plain.include; changed = true; }
  if (plain.reasoning && typeof plain.reasoning === "object" && (plain.reasoning as JsonObject).summary !== undefined) {
    const { summary: _, ...rest } = plain.reasoning as JsonObject;
    if (Object.keys(rest).length) plain.reasoning = rest; else delete plain.reasoning;
    changed = true;
  }
  return changed ? plain : undefined;
}

/**
 * Sends a Claude Code request, and once more without replayed reasoning when the upstream rejects it.
 * Replayed reasoning stays in the history, so one the upstream refuses would fail every later turn.
 */
export async function upstreamRequestWithReplay(request: AdapterRequest, path: string, body: JsonObject): Promise<{ response: Response; abort: () => void }> {
  const first = await upstreamRequest(request, path, body);
  const plain = first.response.status === 400 || first.response.status === 422 ? withoutReasoning(body) : undefined;
  if (!plain) return first;
  const retried = await upstreamRequest(request, path, plain);
  if (!retried.response.ok) { retried.abort(); return first; }
  first.abort();
  return retried;
}
