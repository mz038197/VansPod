import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { captureSearchRequest, type ReceivedRequest } from "../searchRequestCapture";

// Temporary with the #23 diagnostic: docs/verification/search-request-capture.md.

const KEY = "vcr_sk_synthetic/classroom+key";

async function recordsWrittenBy(run: (directory: string) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const directory = await fs.mkdtemp(nodePath.join(os.tmpdir(), "vanspod-capture-"));
  try {
    await run(directory);
    const names = (await fs.readdir(directory)).sort();
    return await Promise.all(names.map(async name => JSON.parse(await fs.readFile(nodePath.join(directory, name), "utf8"))));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function received(request: Partial<ReceivedRequest> & Pick<ReceivedRequest, "client" | "url" | "body">): ReceivedRequest {
  return { method: "POST", headers: {}, classroomApiKey: async () => KEY, ...request };
}

test("Search request capture records every Codex search command with the path and query Codex sent", async () => {
  const bodies = [{ commands: { search_query: [{ q: "台中活動" }] } }, { commands: { open: [{ ref_id: "https://example.com/" }] } }];
  const records = await recordsWrittenBy(async directory => {
    for (const body of bodies) await captureSearchRequest(directory, received({ client: "codex", url: "/v1/alpha/search?client_version=1.2.3", body: JSON.stringify(body) }));
    await captureSearchRequest(directory, received({ client: "codex", url: "/v1/responses", body: JSON.stringify({ model: "allowed", input: "搜尋台中活動" }) }));
  });
  assert.deepEqual(records, bodies.map(body => ({ client: "codex", method: "POST", path: "/v1/alpha/search?client_version=1.2.3", body })));
});

test("Search request capture records only the Claude Code request that declares the server-side web search tool", async () => {
  const search = { model: "claude-synthetic", max_tokens: 100, messages: [{ role: "user", content: "Perform a web search for the query: 台中活動" }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }] };
  const ordinary = { ...search, tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }] };
  const records = await recordsWrittenBy(async directory => {
    for (const body of [ordinary, search]) await captureSearchRequest(directory, received({ client: "claude", url: "/v1/messages?beta=true", body: JSON.stringify(body) }));
    await captureSearchRequest(directory, received({ client: "claude", url: "/v1/messages/count_tokens?beta=true", body: JSON.stringify(search) }));
  });
  assert.deepEqual(records, [{ client: "claude", method: "POST", path: "/v1/messages?beta=true", body: search }]);
});

test("Search request capture writes no header and scrubs the Classroom API Key and the client's credential headers from path and body", async () => {
  const bearer = "synthetic-\"bearer\"\\token", session = "synthetic session/cookie", theme = "synthetic-theme";
  const headers = { authorization: `Bearer ${bearer}`, "x-api-key": "synthetic-header-key", cookie: `session=${encodeURIComponent(session)}; theme=${theme}; a=1`, "set-cookie": ["synthetic-list-cookie"], "user-agent": "codex-synthetic-agent" };
  const body = {
    commands: { search_query: [{ q: `1 literal ${KEY} ${bearer} ${theme} synthetic-header-key synthetic-list-cookie` }] },
    encoded: `https://example.com/?key=${encodeURIComponent(KEY)}&lower=${encodeURIComponent(KEY).toLowerCase()}&s=${encodeURIComponent(session)}`,
    nested: JSON.stringify({ authorization: `Bearer ${bearer}`, key: KEY }),
    [KEY]: "codex-synthetic-agent",
  };
  const escapedSlash = JSON.stringify(body).split("/").join("\\/");
  const records = await recordsWrittenBy(async directory => {
    await captureSearchRequest(directory, received({ client: "codex", url: `/v1/alpha/search?key=${encodeURIComponent(KEY)}`, headers, body: escapedSlash }));
    await captureSearchRequest(directory, received({ client: "codex", url: "/v1/alpha/search", headers, body: `not json ${JSON.stringify(bearer)} ${KEY}` }));
  });
  assert.deepEqual(records, [{ client: "codex", method: "POST", path: "/v1/alpha/search?key=[redacted]", body: {
    commands: { search_query: [{ q: "1 literal [redacted] [redacted] [redacted] [redacted] [redacted]" }] },
    encoded: "https://example.com/?key=[redacted]&lower=[redacted]&s=[redacted]",
    nested: '{"authorization":"[redacted]","key":"[redacted]"}',
    "[redacted]": "codex-synthetic-agent",
  } }, { client: "codex", method: "POST", path: "/v1/alpha/search", body: 'not json "[redacted]" [redacted]' }]);
});

test("Search request capture records nothing when the Classroom API Key cannot be read", async () => {
  const records = await recordsWrittenBy(async directory => {
    await captureSearchRequest(directory, received({ client: "codex", url: "/v1/alpha/search", body: "{}", classroomApiKey: async () => { throw new Error("storage unavailable"); } }));
  });
  assert.deepEqual(records, []);
});
