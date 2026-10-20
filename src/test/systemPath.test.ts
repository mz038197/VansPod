import assert from "node:assert/strict";
import { it } from "node:test";
import { readSystemPath, withSystemPath } from "../systemPath";

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
