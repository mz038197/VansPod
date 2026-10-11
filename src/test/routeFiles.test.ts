import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRouteFiles } from "../routeFiles";

const PROXY = "http://127.0.0.1:47821";

async function tempRoutes() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-routes-"));
  const paths = {
    codex: path.join(root, "config.toml"),
    claude: path.join(root, "settings.json"),
    vsCode: path.join(root, "vscode.json"),
  };
  return { root, paths, routes: createRouteFiles(paths) };
}

describe("route files", () => {
  it("restores the personal Codex URL across process restarts and preserves other config edits", async () => {
    for (const personalUrl of [undefined, "https://personal.example/v1"]) {
      const { root, routes, paths } = await tempRoutes();
      try {
        await fs.writeFile(paths.codex, `# personal settings\nmodel = "personal"\n${personalUrl ? `openai_base_url = "${personalUrl}"\n` : ""}[mcp]\nserver = "keep"\n`);
        await routes.setCodexRoute(false, PROXY);
        assert.equal((await routes.readCodex()).openai_base_url, personalUrl);
        await routes.setCodexRoute(true, PROXY);
        assert.equal((await routes.readCodex()).openai_base_url, `${PROXY}/v1`);
        const reopened = createRouteFiles(paths);
        // Repeated classroom setup must not replace the original backup with the proxy URL.
        await reopened.setCodexRoute(true, PROXY);
        await fs.appendFile(paths.codex, 'new_setting = "keep-too"\n');
        await reopened.setCodexRoute(false, PROXY);
        assert.equal((await reopened.readCodex()).openai_base_url, personalUrl);
        const restored = await fs.readFile(paths.codex, "utf8");
        assert.match(restored, /# personal settings/);
        assert.match(restored, /model = "personal"/);
        assert.match(restored, /server = "keep"/);
        assert.match(restored, /new_setting = "keep-too"/);
        await reopened.setCodexRoute(true, PROXY);
        await reopened.setCodexRoute(false, PROXY);
        assert.equal((await reopened.readCodex()).openai_base_url, personalUrl);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("cleans a legacy local proxy URL without a backup when restoring personal mode", async () => {
    const { root, routes, paths } = await tempRoutes();
    try {
      for (const legacy of [PROXY, `${PROXY}/v1`]) {
        await fs.writeFile(paths.codex, `openai_base_url = "${legacy}"\nmodel = "personal"\n`);
        await routes.setCodexRoute(false, PROXY);
        assert.equal((await routes.readCodex()).openai_base_url, undefined);
        assert.match(await fs.readFile(paths.codex, "utf8"), /model = "personal"/);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("changes only the Codex route line", async () => {
    const { routes, paths } = await tempRoutes();
    const original = [
      "trust = \"always\"",
      "openai_base_url = \"https://user:secret@old.example/v1?key=vcr_sk_secret\"",
      "",
      "[mcp]",
      "server = \"local\"",
      "",
    ].join("\n");
    await fs.writeFile(paths.codex, original, "utf8");
    const before = await routes.readCodex();
    assert.equal(
      before.openai_base_url,
      "https://user:secret@old.example/v1?key=vcr_sk_secret",
    );
    await routes.writeCodex({ ...before, openai_base_url: PROXY });
    const written = await fs.readFile(paths.codex, "utf8");
    assert.equal(written.includes(`openai_base_url = "${PROXY}"`), true);
    assert.equal(written.includes('trust = "always"'), true);
    assert.equal(written.includes("[mcp]"), true);
    assert.equal(written.includes('server = "local"'), true);
    assert.equal(written.includes("secret"), false);
    assert.equal(written.includes("vcr_sk"), false);
    await routes.writeCodex({});
    const cleared = await fs.readFile(paths.codex, "utf8");
    assert.equal(cleared.includes("openai_base_url"), false);
    assert.equal(cleared.includes('trust = "always"'), true);
    assert.equal(cleared.includes("[mcp]"), true);
    assert.equal(cleared.includes("old.example"), false);
  });

  it("writes Claude ANTHROPIC_BASE_URL under env and leaves API key fields", async () => {
    const { routes, paths } = await tempRoutes();
    await fs.writeFile(
      paths.claude,
      JSON.stringify({
        theme: "dark",
        env: {
          ANTHROPIC_API_KEY: "sk-ant-keep",
          ANTHROPIC_BASE_URL: "https://claude.example",
        },
      }),
      "utf8",
    );
    const before = await routes.readClaudeTerminal();
    assert.equal(before.ANTHROPIC_BASE_URL, "https://claude.example");
    await routes.writeClaudeTerminal({
      ...before,
      ANTHROPIC_BASE_URL: PROXY,
    });
    const written = JSON.parse(await fs.readFile(paths.claude, "utf8")) as {
      theme: string;
      env: Record<string, string>;
      ANTHROPIC_BASE_URL?: string;
    };
    assert.equal(written.env.ANTHROPIC_BASE_URL, PROXY);
    assert.equal(written.env.ANTHROPIC_API_KEY, "sk-ant-keep");
    assert.equal(written.theme, "dark");
    assert.equal(written.ANTHROPIC_BASE_URL, undefined);
    const stopped = { ...before };
    delete stopped.ANTHROPIC_BASE_URL;
    await routes.writeClaudeTerminal(stopped);
    const cleared = JSON.parse(await fs.readFile(paths.claude, "utf8")) as {
      env: Record<string, string>;
    };
    assert.equal(cleared.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(cleared.env.ANTHROPIC_API_KEY, "sk-ant-keep");
    assert.equal(JSON.stringify(cleared).includes("claude.example"), false);
  });

  it("patches VS Code environment variables without dropping comments or other settings", async () => {
    const { routes, paths } = await tempRoutes();
    const original = `{
  // keep this comment
  "editor.fontSize": 14,
  "claudeCode.environmentVariables": [
    { "name": "OTHER", "value": "stay" },
    { "name": "ANTHROPIC_API_KEY", "value": "sk-ant-keep" },
    { "name": "ANTHROPIC_BASE_URL", "value": "https://claude.example" }
  ]
}
`;
    await fs.writeFile(paths.vsCode, original, "utf8");
    const before = await routes.readVsCodeClaude();
    const env = before["claudeCode.environmentVariables"] as Array<{
      name: string;
      value: string;
    }>;
    assert.equal(
      env.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value,
      "https://claude.example",
    );
    await routes.writeVsCodeClaude({
      ...before,
      "claudeCode.environmentVariables": [
        ...env.filter((entry) => entry.name !== "ANTHROPIC_BASE_URL"),
        { name: "ANTHROPIC_BASE_URL", value: PROXY },
      ],
    });
    const written = await fs.readFile(paths.vsCode, "utf8");
    assert.equal(written.includes("// keep this comment"), true);
    assert.equal(written.includes('"editor.fontSize": 14'), true);
    assert.equal(written.includes(PROXY), true);
    assert.equal(written.includes("sk-ant-keep"), true);
    assert.equal(written.includes('"OTHER"'), true);
    assert.equal(written.includes("claude.example"), false);
  });

  it("writes Codex catalog keys in the root and drops copies inside a later table", async () => {
    const { routes, paths } = await tempRoutes();
    const original = [
      "trust = \"always\"",
      "",
      "[mcp]",
      "server = \"local\"",
      "",
      "[shell_environment_policy.set]",
      "openai_base_url = \"http://127.0.0.1:47821\"",
      "model_catalog_json = \"C:\\\\wrong\\\\classroom-catalog.json\"",
      "",
    ].join("\n");
    await fs.writeFile(paths.codex, original, "utf8");
    await routes.setModelOptions({
      ids: ["vcr-auto"],
      codexModel: "vcr-auto",
      claudeModel: "vcr-auto",
      proxyBaseUrl: PROXY,
    });
    await routes.writeCodex({ openai_base_url: PROXY });
    const toml = await fs.readFile(paths.codex, "utf8");
    const root = toml.slice(0, toml.indexOf("[mcp]"));
    const table = toml.slice(toml.indexOf("[shell_environment_policy.set]"));
    assert.equal(root.includes("model_catalog_json = "), true);
    assert.equal(root.includes('model = "VCRouter/vcr-auto"'), true);
    assert.equal(root.includes('openai_base_url = "http://127.0.0.1:47821"'), true);
    assert.equal(table.includes("openai_base_url"), false);
    assert.equal(table.includes("model_catalog_json"), false);
    assert.equal(toml.includes('server = "local"'), true);
  });

  it("publishes the allowlist as the Codex and Claude pickers, then restores", async () => {
    const { routes, paths, root } = await tempRoutes();
    await fs.writeFile(
      paths.codex,
      'model = "gpt-5.6-luna"\nmodel_catalog_json = "native.json"\ntrust = "always"\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "models_cache.json"),
      '{"fetched_at":"2026-01-01T00:00:00Z","models":[{"slug":"gpt-5.6-luna","visibility":"list","shell_type":"shell_command","context_window":128000,"supported_reasoning_levels":[{"effort":"medium","description":"medium"}]}]}\n',
      "utf8",
    );
    await fs.writeFile(
      paths.claude,
      `{
  // keep claude
  "theme": "dark",
  "model": "claude-sonnet"
}
`,
      "utf8",
    );
    await fs.mkdir(path.join(root, "cache"), { recursive: true });
    await fs.writeFile(
      path.join(root, "cache", "gateway-models.json"),
      '{"baseUrl":"https://api.anthropic.com","models":[{"id":"claude-sonnet"}]}\n',
      "utf8",
    );
    await routes.setModelOptions({
      ids: ["ollama_cloud@minimax-m3:cloud", "later"],
      codexModel: "ollama_cloud@minimax-m3:cloud",
      claudeModel: "later",
      proxyBaseUrl: PROXY,
    });
    const toml = await fs.readFile(paths.codex, "utf8");
    assert.equal(toml.includes('trust = "always"'), true);
    assert.equal(toml.includes('model = "VCRouter/ollama_cloud@minimax-m3:cloud"'), true);
    assert.equal(toml.includes("classroom-catalog.json"), true);
    assert.equal(toml.includes("native.json"), false);
    const catalog = JSON.parse(
      await fs.readFile(path.join(root, "classroom-catalog.json"), "utf8"),
    ) as {
      models: Array<{
        slug: string;
        visibility: string;
        shell_type: string;
        context_window: number;
        supported_reasoning_levels: Array<{ effort: string }>;
      }>;
    };
    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      [
        "VCRouter/ollama_cloud@minimax-m3:cloud",
        "VCRouter/later",
      ],
    );
    assert.equal(catalog.models[0]?.visibility, "list");
    assert.equal(catalog.models[0]?.shell_type, "shell_command");
    assert.equal(catalog.models[0]?.context_window, 128000);
    assert.equal(
      catalog.models.some((model) => model.slug === "gpt-5.6-luna"),
      false,
    );
    const cache = JSON.parse(
      await fs.readFile(path.join(root, "models_cache.json"), "utf8"),
    ) as { fetched_at: string; models: Array<{ slug: string }> };
    assert.equal(cache.fetched_at, "2000-01-01T00:00:00Z");
    assert.deepEqual(
      cache.models.map((model) => model.slug),
      [
        "VCRouter/ollama_cloud@minimax-m3:cloud",
        "VCRouter/later",
      ],
    );
    const claude = await fs.readFile(paths.claude, "utf8");
    assert.equal(claude.includes("// keep claude"), true);
    assert.equal(claude.includes('"theme": "dark"'), true);
    assert.equal(claude.includes('"model": "later"'), true);
    const gateway = JSON.parse(
      await fs.readFile(path.join(root, "cache", "gateway-models.json"), "utf8"),
    ) as { baseUrl: string; models: Array<{ id: string }> };
    assert.equal(gateway.baseUrl, PROXY);
    assert.deepEqual(
      gateway.models.map((model) => model.id),
      ["ollama_cloud@minimax-m3:cloud", "later"],
    );
    const reopened = createRouteFiles(paths);
    await reopened.setModelOptions(null);
    const restored = await fs.readFile(paths.codex, "utf8");
    assert.equal(restored.includes('model = "gpt-5.6-luna"'), true);
    assert.equal(restored.includes('model_catalog_json = "native.json"'), true);
    assert.equal(restored.includes("classroom-catalog.json"), false);
    assert.equal(restored.includes('trust = "always"'), true);
    const restoredCache = await fs.readFile(
      path.join(root, "models_cache.json"),
      "utf8",
    );
    assert.equal(restoredCache.includes("gpt-5.6-luna"), true);
    assert.equal(restoredCache.includes("2000-01-01"), false);
    const restoredClaude = await fs.readFile(paths.claude, "utf8");
    assert.equal(restoredClaude.includes("// keep claude"), true);
    assert.equal(restoredClaude.includes('"model": "claude-sonnet"'), true);
    assert.equal(restoredClaude.includes('"theme": "dark"'), true);
    const restoredGateway = await fs.readFile(
      path.join(root, "cache", "gateway-models.json"),
      "utf8",
    );
    assert.equal(restoredGateway.includes("api.anthropic.com"), true);
  });
});
