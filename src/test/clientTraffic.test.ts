import assert from "node:assert/strict";
import { it } from "node:test";
import { createClientTraffic } from "../clientTraffic";

it("flows only for the Client Route with a request in flight, and stops shortly after it ends", () => {
  let at = 0;
  const traffic = createClientTraffic(() => at);
  assert.deepEqual(traffic.flowing(), { codex: false, claude: false, vscode: false });

  const first = traffic.begin("claude");
  const second = traffic.begin("claude");
  at = 60_000;
  assert.deepEqual(traffic.flowing(), { codex: false, claude: true, vscode: false });

  first(); first();
  at = 120_000;
  assert.equal(traffic.flowing().claude, true);

  second();
  at += 1_000;
  assert.equal(traffic.flowing().claude, true);
  at += 1_000;
  assert.equal(traffic.flowing().claude, false);
});
