import assert from "node:assert/strict";
import { it } from "node:test";
import { ClassroomKeyRejectedError } from "../classroomKeyRejection";
import { fetchCourseCatalog } from "../routerCourseCatalog";

it("the course catalog is fetched with the Classroom API Key and returned as Router sent it", async () => {
  const body = { course_catalog_yaml: "actions: []\nsnippets: []\n" };
  const result = await fetchCourseCatalog({
    root: "https://router.example/",
    apiKey: "synthetic-key",
    request: async (input, init) => {
      assert.equal(String(input), "https://router.example/extension/course-catalog");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-key");
      return Response.json(body);
    },
  });
  assert.deepEqual(result, body);
});

it("Router refusing the Classroom API Key for the course catalog reports why", async () => {
  for (const [status, detail, reason] of [
    [401, "API 金鑰已過期，請至 Portal 重新取得邀請碼", "expired"],
    [403, "權限不足", "invalid"],
  ] as const) {
    await assert.rejects(
      fetchCourseCatalog({ root: "https://router.example", apiKey: "synthetic-key", request: async () => Response.json({ detail }, { status }) }),
      (error: unknown) => error instanceof ClassroomKeyRejectedError && error.reason === reason,
    );
  }
});

it("a 403 block page from a network filter in front of Router is a generic course catalog failure", async () => {
  await assert.rejects(
    fetchCourseCatalog({
      root: "https://router.example",
      apiKey: "synthetic-key",
      request: async () => new Response("<html><body>此網站已被封鎖</body></html>", { status: 403, headers: { "content-type": "text/html" } }),
    }),
    (error: unknown) => !(error instanceof ClassroomKeyRejectedError) && /course catalog failed/.test(String(error)),
  );
});
