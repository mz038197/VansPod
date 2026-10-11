import { AdapterError, object, type JsonObject } from "./types";

export function event(type: string, body: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

export async function* frames(response: Response): AsyncGenerator<{ raw: string; data: JsonObject | "[DONE]" }> {
  if (!response.body) throw new AdapterError("上游串流沒有正文。", 502);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index + match[0].length); buffer = buffer.slice(raw.length);
        const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") yield { raw, data };
        else {
          let parsed: unknown; try { parsed = JSON.parse(data); } catch { throw new AdapterError("上游 SSE 資料不是有效 JSON。", 502); }
          yield { raw, data: object(parsed, "SSE data") };
        }
      }
      if (buffer.length > 1_048_576) throw new AdapterError("上游 SSE 事件過大。", 502);
      if (next.done) { if (buffer.trim()) throw new AdapterError("上游 SSE 事件未完整結束。", 502); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Pull-based transformation preserves backpressure; cancellation releases the upstream reader.
export function streamResponse(source: AsyncGenerator<string>, abortUpstream: () => void): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await source.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
      catch (error) { abortUpstream(); controller.error(error); }
    },
    async cancel() { abortUpstream(); await source.return(undefined).catch(() => {}); },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
}

export async function* nativeStream(response: Response, wire: "responses" | "messages"): AsyncGenerator<string> {
  let completed = false;
  for await (const frame of frames(response)) {
    if (frame.data !== "[DONE]") {
      const type = frame.data.type;
      if (type === "error" || type === "response.failed") throw new AdapterError("上游串流回報失敗。", 502);
      if (wire === "responses" ? type === "response.completed" || type === "response.incomplete" : type === "message_stop") completed = true;
    }
    yield frame.raw;
  }
  if (!completed) throw new AdapterError("上游串流中斷，未收到完成事件。", 502);
}
