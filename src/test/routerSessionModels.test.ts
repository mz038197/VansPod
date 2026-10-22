import assert from "node:assert/strict";
import { it } from "node:test";
import { ClassroomKeyRejectedError } from "../classroomKeyRejection";
import { fetchSessionModelProviders } from "../routerSessionModels";

it("the production Router catalog adapter rejects malformed payloads instead of normalizing them to empty", async () => {
  for (const payload of [
    null,
    {},
    [null],
    [{ models: [] }, "invalid"],
    [{}],
    [{ models: [null] }],
    [{ models: [{ id: "" }] }],
  ]) {
    await assert.rejects(
      fetchSessionModelProviders({
        root: "https://router.example",
        apiKey: "synthetic-key",
        request: async () => Response.json(payload),
      }),
      /session models failed/,
    );
  }
});

it("the production Router catalog adapter preserves valid provider metadata and authoritative empty arrays", async () => {
  const provider = { name: "VCRouter", models: [{ id: "lesson", vision: true }] };
  for (const payload of [[], [provider]]) {
    const result = await fetchSessionModelProviders({
      root: "https://router.example/",
      apiKey: "synthetic-key",
      request: async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-key");
        return Response.json(payload);
      },
    });
    assert.deepEqual(result, payload);
  }
});

it("Router saying the Classroom API Key has expired is reported as an expired key, not a generic failure", async () => {
  await assert.rejects(
    fetchSessionModelProviders({
      root: "https://router.example",
      apiKey: "synthetic-key",
      request: async () => Response.json({ detail: "API 金鑰已過期，請至 Portal 重新取得邀請碼" }, { status: 401 }),
    }),
    (error: unknown) => error instanceof ClassroomKeyRejectedError && error.reason === "expired",
  );
});

it("Router refusing an invalid or disabled Classroom API Key is reported as an invalid key, not a generic failure", async () => {
  await assert.rejects(
    fetchSessionModelProviders({
      root: "https://router.example",
      apiKey: "synthetic-key",
      request: async () => Response.json({ detail: "權限不足" }, { status: 403 }),
    }),
    (error: unknown) => error instanceof ClassroomKeyRejectedError && error.reason === "invalid",
  );
});

it("a 403 block page from a network filter in front of Router is a generic failure, not an invalid Classroom API Key", async () => {
  await assert.rejects(
    fetchSessionModelProviders({
      root: "https://router.example",
      apiKey: "synthetic-key",
      request: async () => new Response("<html><body>此網站已被封鎖</body></html>", { status: 403, headers: { "content-type": "text/html" } }),
    }),
    (error: unknown) => !(error instanceof ClassroomKeyRejectedError) && /session models failed/.test(String(error)),
  );
});
