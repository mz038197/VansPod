import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createRouteFiles } from "../routeFiles";

const CODEX_ORIGIN = "http://127.0.0.1:47821";
const CLAUDE_ORIGIN = "http://127.0.0.1:47822";

async function tempRoutes() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-routes-"));
  const paths = { codex: path.join(root, "config.toml"), claude: path.join(root, "settings.json"), vsCode: path.join(root, "vscode.json") };
  return { root, paths, routes: createRouteFiles(paths) };
}

it("exposes only independent route writers and the versioned legacy migration", async () => {
  const { root, routes } = await tempRoutes();
  try {
    assert.deepEqual(Object.keys(routes).sort(), ["migrateLegacyState", "setClaudeCodeRoute", "setCodexRoute"]);
    assert.equal("setClaudeRoute" in routes, false);
    assert.equal("setModelOptions" in routes, false);
    assert.equal("readVsCodeClaude" in routes, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("journals the complete Codex route and restores only fields VansPod still owns", async () => {
  const { root, paths, routes } = await tempRoutes();
  try {
    await fs.writeFile(paths.codex, 'model = "personal"\nopenai_base_url = "https://personal.example/v1"\ntrust = "old"\n');
    await routes.setCodexRoute({ mode: "classroom", ids: ["lesson", "later"], selectedModel: "lesson", proxyBaseUrl: CODEX_ORIGIN });
    const managed = await fs.readFile(paths.codex, "utf8");
    assert.match(managed, /openai_base_url = "http:\/\/127\.0\.0\.1:47821\/v1"/);
    assert.match(managed, /model = "VCRouter\/lesson"/);
    assert.match(managed, /classroom-catalog\.json/);
    await fs.appendFile(paths.codex, 'external = "keep"\n');
    await routes.setCodexRoute({ mode: "native", proxyBaseUrl: CODEX_ORIGIN });
    const restored = await fs.readFile(paths.codex, "utf8");
    assert.match(restored, /model = "personal"/);
    assert.match(restored, /openai_base_url = "https:\/\/personal\.example\/v1"/);
    assert.match(restored, /external = "keep"/);
    await assert.rejects(fs.access(path.join(root, "classroom-codex-settings-backup.json")), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("Native cleanup uses the configured Codex listener origin when no journal exists", async () => {
  const { root, paths, routes } = await tempRoutes();
  try {
    const customOrigin = "http://127.0.0.1:49123";
    await fs.writeFile(paths.codex, `openai_base_url = "${customOrigin}/v1"\ntrust = "keep"\n`);
    await routes.setCodexRoute({ mode: "native", proxyBaseUrl: customOrigin });
    const restored = await fs.readFile(paths.codex, "utf8");
    assert.doesNotMatch(restored, /openai_base_url/);
    assert.match(restored, /trust = "keep"/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("journals Claude Code without touching VS Code settings or official credentials", async () => {
  const { root, paths, routes } = await tempRoutes();
  try {
    const originalVsCode = { "claudeCode.environmentVariables": [{ name: "ANTHROPIC_BASE_URL", value: "https://vscode.example" }] };
    await fs.writeFile(paths.claude, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://personal.example", ANTHROPIC_API_KEY: "official", KEEP: "yes" }, theme: "dark" }));
    await fs.writeFile(paths.vsCode, JSON.stringify(originalVsCode));
    await routes.setClaudeCodeRoute(true, CLAUDE_ORIGIN);
    const managed = JSON.parse(await fs.readFile(paths.claude, "utf8"));
    assert.equal(managed.env.ANTHROPIC_BASE_URL, CLAUDE_ORIGIN);
    assert.equal(managed.env.ANTHROPIC_API_KEY, "official");
    managed.theme = "light";
    await fs.writeFile(paths.claude, JSON.stringify(managed));
    await routes.setClaudeCodeRoute(false, CLAUDE_ORIGIN);
    const restored = JSON.parse(await fs.readFile(paths.claude, "utf8"));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://personal.example");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "official");
    assert.equal(restored.theme, "light");
    assert.deepEqual(JSON.parse(await fs.readFile(paths.vsCode, "utf8")), originalVsCode);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("migrates the old combined Claude journal once and initializes clean personal state", async () => {
  const { root, paths, routes } = await tempRoutes();
  try {
    const personalCli = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://personal.example", KEEP: "old" }, theme: "dark" });
    const managedCli = JSON.stringify({ env: { ANTHROPIC_BASE_URL: CODEX_ORIGIN, KEEP: "old" }, theme: "dark" });
    const personalVsCode = JSON.stringify({ "claudeCode.environmentVariables": [{ name: "OTHER", value: "keep" }] });
    const managedVsCode = JSON.stringify({ "claudeCode.environmentVariables": [{ name: "OTHER", value: "keep" }, { name: "ANTHROPIC_BASE_URL", value: CODEX_ORIGIN }] });
    await fs.writeFile(paths.claude, managedCli);
    await fs.writeFile(paths.vsCode, managedVsCode);
    await fs.writeFile(path.join(root, "classroom-claude-settings-backup.json"), JSON.stringify({
      config: { original: personalCli, written: managedCli, keys: ["env.ANTHROPIC_BASE_URL"] },
      vscode: { original: personalVsCode, written: managedVsCode, keys: ["vscodeBase"] },
    }));
    await routes.migrateLegacyState(CODEX_ORIGIN);
    assert.equal(JSON.parse(await fs.readFile(paths.claude, "utf8")).env.ANTHROPIC_BASE_URL, "https://personal.example");
    assert.deepEqual(JSON.parse(await fs.readFile(paths.vsCode, "utf8"))["claudeCode.environmentVariables"], [{ name: "OTHER", value: "keep" }]);
    await assert.rejects(fs.access(path.join(root, "classroom-claude-settings-backup.json")), { code: "ENOENT" });
    await routes.migrateLegacyState(CODEX_ORIGIN);
    assert.equal(JSON.parse(await fs.readFile(paths.claude, "utf8")).env.ANTHROPIC_BASE_URL, "https://personal.example");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("legacy migration removes only recognized VansPod values without a journal", async () => {
  const { root, paths, routes } = await tempRoutes();
  try {
    await fs.writeFile(paths.claude, JSON.stringify({ env: { ANTHROPIC_BASE_URL: CODEX_ORIGIN, ANTHROPIC_API_KEY: "official", KEEP: "yes" } }));
    await fs.writeFile(paths.vsCode, JSON.stringify({ "claudeCode.environmentVariables": [
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:9999" },
      { name: "ANTHROPIC_BASE_URL", value: CODEX_ORIGIN },
    ], "editor.fontSize": 17 }));
    await routes.migrateLegacyState(CODEX_ORIGIN);
    const cli = JSON.parse(await fs.readFile(paths.claude, "utf8"));
    assert.equal(cli.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(cli.env.ANTHROPIC_API_KEY, "official");
    assert.deepEqual(JSON.parse(await fs.readFile(paths.vsCode, "utf8"))["claudeCode.environmentVariables"], [
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:9999" },
    ]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
