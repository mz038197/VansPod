import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { once } from "node:events";

export type RouterCall = { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders };

// A reply the fake Router sends with a failing HTTP status.
export class Failure { constructor(readonly status: number, readonly body: unknown) {} }

// A real client request kept under src/test/fixtures. Tests run from dist/, the samples stay in src/.
export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "../../src/test/fixtures", name), "utf8")) as T;
}

// A fake Router that records what it is asked. A list of replies is played in order,
// whichever endpoint is asked; a function answers every call. A string is sent as an
// SSE stream, anything else as JSON.
export async function withFakeRouter(replies: unknown[] | ((call: RouterCall) => unknown), run: (url: string, calls: RouterCall[]) => Promise<void>): Promise<void> {
  const calls: RouterCall[] = [], queue = Array.isArray(replies) ? [...replies] : undefined;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const call = { path: req.url ?? "", body: JSON.parse(raw), headers: req.headers }; calls.push(call);
    const reply = queue ? queue.shift() : (replies as (call: RouterCall) => unknown)(call);
    if (reply === undefined) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fake Router has nothing left to say" } })); return; }
    if (reply instanceof Failure) { res.writeHead(reply.status, { "content-type": "application/json" }); res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)); }
    else if (typeof reply === "string") { res.setHeader("content-type", "text/event-stream"); res.end(reply); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { const address = server.address(); assert.ok(address && typeof address !== "string"); await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
