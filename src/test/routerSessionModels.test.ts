import assert from "node:assert/strict";
import { it } from "node:test";
import { ClassroomKeyExpiredError, fetchSessionModelProviders } from "../routerSessionModels";

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
    ClassroomKeyExpiredError,
  );
});
