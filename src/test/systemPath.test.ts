import assert from "node:assert/strict";
import { it } from "node:test";
import { readSystemPath, sharedWhileRunning, withSystemPath } from "../systemPath";

it("shares one registry read between callers that ask at the same time, and reads again once it has finished", async () => {
  let reads = 0;
  const read = sharedWhileRunning(async () => { reads += 1; return [`C:\\read${reads}`]; });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(reads, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(await read(), ["C:\\read2"]);
});

it("reads the machine and user PATH from the registry with variables expanded", { skip: process.platform !== "win32" }, async () => {
  const entries = (await readSystemPath()).map(entry => entry.toLowerCase().replace(/\\+$/, ""));
  assert.ok(entries.includes(`${process.env.SystemRoot}\\system32`.toLowerCase()), entries.join(";"));
  assert.ok(entries.every(entry => !entry.includes("%systemroot%")));
});

it("appends folders an installer added to the system PATH after the service started, keeping the service's own order", () => {
  const env = withSystemPath(
    { Path: "C:\\tools;C:\\Windows\\system32", SystemRoot: "C:\\Windows" },
    ["%SystemRoot%\\System32", "C:\\Program Files\\nodejs\\", "C:\\tools"],
  );
  assert.equal(env.Path, "C:\\tools;C:\\Windows\\system32;C:\\Program Files\\nodejs\\");
});

it("keeps the existing PATH key spelling so the child process does not get two PATH variables", () => {
  const env = withSystemPath({ PATH: "C:\\a", Other: "1" }, ["C:\\b"]);
  assert.deepEqual(env, { PATH: "C:\\a;C:\\b", Other: "1" });
});

it("leaves variables it cannot expand untouched and skips empty entries", () => {
  const env = withSystemPath({ Path: "C:\\a;" }, ["%MISSING%\\bin", ""]);
  assert.equal(env.Path, "C:\\a;%MISSING%\\bin");
});
