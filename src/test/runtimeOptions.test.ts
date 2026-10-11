import assert from "node:assert/strict";
import { it } from "node:test";
import { readRuntimeOptions } from "../runtimeOptions";

it("headless runtime uses a private port and disables desktop actions and client restarts", () => {
  assert.deepEqual(readRuntimeOptions({ CLASSROOM_APP_HEADLESS: "1", CLASSROOM_APP_PORT: "49123" }), {
    port: 49123, desktop: false, restartClients: false,
  });
});

it("normal runtime preserves the established desktop defaults and rejects invalid ports", () => {
  assert.deepEqual(readRuntimeOptions({}), { port: 47821, desktop: true, restartClients: true });
  for (const port of ["0", "65536", "bad", "47821.5"]) assert.throws(() => readRuntimeOptions({ CLASSROOM_APP_PORT: port }), /連接埠/);
});
