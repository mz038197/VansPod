import assert from "node:assert/strict";
import { it } from "node:test";
import { exitDecision, removalInterruptions } from "../exitGuard";

it("exits at once when nothing would be interrupted", () => {
  assert.deepEqual(exitDecision("stop", { installing: false, activeRequests: 0 }, false), { proceed: true });
});

it("asks once, naming every interruption, before stopping or removing", () => {
  const busy = { installing: true, activeRequests: 2 };
  const stop = exitDecision("stop", busy, false);
  assert.equal(stop.proceed, false);
  assert.match(stop.proceed ? "" : stop.message, /安裝仍在執行、仍有模型回答.*確認中止並結束 VansPod/);
  const uninstall = exitDecision("uninstall", busy, false);
  assert.match(uninstall.proceed ? "" : uninstall.message, /安裝仍在執行、仍有模型回答.*確認中止並移除 VansPod/);
});

it("names only what is actually running", () => {
  const installOnly = exitDecision("stop", { installing: true, activeRequests: 0 }, false);
  assert.equal(installOnly.proceed ? "" : installOnly.message, "安裝仍在執行，確認中止並結束 VansPod？");
  const answersOnly = exitDecision("stop", { installing: false, activeRequests: 1 }, false);
  assert.equal(answersOnly.proceed ? "" : answersOnly.message, "仍有模型回答，確認中止並結束 VansPod？");
});

it("proceeds after the single confirmation", () => {
  assert.deepEqual(exitDecision("uninstall", { installing: true, activeRequests: 1 }, true), { proceed: true });
});

it("lists interruptions in the removal preview", () => {
  assert.equal(removalInterruptions({ installing: false, activeRequests: 0 }), "");
  assert.equal(removalInterruptions({ installing: true, activeRequests: 0 }), "\n安裝仍在執行，移除前將中止安裝。");
  assert.equal(removalInterruptions({ installing: true, activeRequests: 3 }), "\n安裝仍在執行，移除前將中止安裝。\n仍有模型回答，移除將中斷目前回答。");
});

it("asks before a 版本更新 interrupts a model answer", () => {
  const update = exitDecision("update", { installing: false, activeRequests: 1 }, false);
  assert.equal(update.proceed ? "" : update.message, "仍有模型回答，確認中止並更新 VansPod？");
});
