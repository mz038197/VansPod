import { runCli } from "./launcher";
import fs from "node:fs/promises";
import path from "node:path";
import { managementDirectory } from "./instance";

void runCli().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "VansPod 操作失敗。";
  if (process.env.VANSPOD_WORKER_TOKEN) {
    await fs.writeFile(path.join(managementDirectory(), "startup-error.json"), JSON.stringify({ message }), { mode: 0o600 }).catch(() => undefined);
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
