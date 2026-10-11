import type { ConnectionStorage } from "./secureStorage";
import { StorageError } from "./storageErrors";
import {
  parseCourseCatalog,
  type InstallAction,
  type LessonSnippet,
} from "./courseCatalog";
import type { CommandResult } from "./commandRunner";
import {
  VS_CODE_ENV,
  anthropicBaseValues,
  withVsCodeBaseUrl,
  withoutVsCodeBaseUrl,
  type ModelOptions,
} from "./routeFiles";

export type NicknameRedeemResult = {
  api_key: string;
  session: {
    class_name?: string;
    name?: string;
    invite_code?: string;
    expires_at?: string;
  };
};

export type ModelSwitchMode = "native" | "classroom";

export const ENVIRONMENT_TOOLS = ["uv", "git", "node", "pwsh"] as const;

export type EnvironmentToolId = (typeof ENVIRONMENT_TOOLS)[number];

const ENVIRONMENT_LABEL: Record<EnvironmentToolId, string> = {
  uv: "uv",
  git: "git",
  node: "Node.js",
  pwsh: "PowerShell 7",
};

export type MustRestartClient = "codex" | "claude" | "vscode";

export type CopilotDocument = {
  providers: Array<Record<string, unknown>>;
};

export type ClassroomAppDeps = {
  router: {
    redeemNickname(body: {
      invite_code: string;
      nickname: string;
    }): Promise<NicknameRedeemResult>;
    fetchSessionModels(apiKey: string): Promise<string[]>;
  };
  catalog: {
    fetchCourseCatalog(
      apiKey: string,
    ): Promise<{ course_catalog_yaml?: unknown }>;
  };
  projectFiles: {
    readClassroomInstalls(folder: string): Promise<string | undefined>;
  };
  clipboard: {
    write(text: string): Promise<void>;
  };
  commands: {
    run(cwd: string, command: string, onOutput?: (output: string) => void): Promise<CommandResult>;
  };
  environment: {
    probe(tool: EnvironmentToolId): Promise<{ installed: boolean }>;
    install(
      tool: EnvironmentToolId,
      cwd: string,
    ): Promise<{ exitCode: number | undefined; output: string }>;
  };
  // 測試注入的寫檔口。核心不呼叫它，MCP 動作只跑 catalog command。
  files: {
    write(path: string, contents: string): Promise<void>;
  };
  storage: ConnectionStorage;
  stopProcess(): void;
  proxyBaseUrl: string;
  routes: {
    readCodex(): Promise<Record<string, unknown>>;
    writeCodex(doc: Record<string, unknown>): Promise<void>;
    readClaudeTerminal(): Promise<Record<string, unknown>>;
    writeClaudeTerminal(doc: Record<string, unknown>): Promise<void>;
    readVsCodeClaude(): Promise<Record<string, unknown>>;
    writeVsCodeClaude(doc: Record<string, unknown>): Promise<void>;
    setModelOptions(options: ModelOptions | null): Promise<void>;
  };
  copilot: {
    read(): Promise<CopilotDocument>;
    write(doc: CopilotDocument): Promise<void>;
  };
  proxy: {
    start(): void;
    stop(): void;
    receive(request: { provider: "VCRouter" }): Promise<void>;
  };
  send(upstream: UpstreamSend): Promise<void>;
};

export type CourseCatalogView = {
  source: "remote" | "local";
  actions: InstallAction[];
  snippets?: LessonSnippet[];
  localNote?: string;
};

export type ProxyClient = "codex" | "claude" | "copilot";

export type UpstreamTarget = "router" | "chatgpt" | "claude.ai";

export type UpstreamSend = {
  client: ProxyClient;
  target: UpstreamTarget;
  model: string;
  apiKey?: string;
  method?: string;
  path?: string;
  body?: string;
};

export type ForwardedRecord = {
  client: ProxyClient;
  target: UpstreamTarget;
  model: string;
};

export type ClientForward = {
  client: ProxyClient;
  model: string;
  method?: string;
  path?: string;
  body?: string;
};

export type EnvironmentToolView = {
  id: EnvironmentToolId;
  label: string;
  installed: boolean;
  selected: boolean;
};

export type ClassroomAppView = {
  connected: boolean;
  classLabel?: string;
  nickname?: string;
  courseTitle?: string;
  sessionTitle?: string;
  detail: string;
  canCopyKey: boolean;
  notice?: string;
  projectFolder?: string;
  folderError?: string;
  installAvailable: boolean;
  installNotice?: string;
  catalog?: CourseCatalogView;
  catalogError?: string;
  pendingCommand?: string;
  commandOutput?: string;
  commandRunning: boolean;
  commandSucceeded?: boolean;
  installedActionIds?: string[];
  mode: ModelSwitchMode;
  modelId?: string;
  tools: EnvironmentToolView[];
  environmentNotice?: string;
  mustRestart?: MustRestartClient[];
};

const LOCAL_LIST_NOTE = "這是本機清單。";
const INSTALL_UNAVAILABLE = "尚未指定專案資料夾，安裝不可用。";
const REOPEN_TERMINAL = "請重開終端機再重新檢查。";
const MODEL_SUBSTITUTED = "正在用的模型不在清單裡，已改送第一個。";
const PROXY_CLIENTS: ProxyClient[] = ["codex", "claude", "copilot"];
export class ClassroomApp {
  private readonly hiddenKeys = new Set<string>();
  private initialization: Promise<void> | undefined;
  private connected = false;
  private classLabel: string | undefined;
  private nickname: string | undefined;
  private courseTitle: string | undefined;
  private sessionTitle: string | undefined;
  private detail = "";
  private notice: string | undefined;
  private projectFolder: string | undefined;
  private folderError: string | undefined;
  private catalog: CourseCatalogView | undefined;
  private catalogError: string | undefined;
  private remoteCatalogHeld = false;
  private pendingCommand: string | undefined;
  private pendingActionId: string | undefined;
  private installedActions = new Map<string, Map<string, string>>();
  private commandOutput: string | undefined;
  private commandRunning = false;
  private commandSucceeded: boolean | undefined;
  private mode: ModelSwitchMode = "native";
  private modelIds: string[] = [];
  private environmentInstalled: Record<EnvironmentToolId, boolean> = {
    uv: false,
    git: false,
    node: false,
    pwsh: false,
  };
  private environmentSelected = new Set<EnvironmentToolId>();
  private environmentNotice: string | undefined;
  private proxyRunning = false;
  private mustRestart: MustRestartClient[] = [];
  private routeRestartNoted = false;
  private sending = new Map<ProxyClient, string>();
  private modelNotice = new Set<ProxyClient>();

  constructor(private readonly deps: ClassroomAppDeps) {}

  view(): ClassroomAppView {
    const view: ClassroomAppView = {
      connected: this.connected,
      detail: this.detail,
      canCopyKey: this.connected,
      installAvailable: Boolean(this.projectFolder),
      commandRunning: this.commandRunning,
      mode: this.mode,
      tools: this.environmentTools(),
    };
    if (this.classLabel) {
      view.classLabel = this.classLabel;
    }
    if (this.nickname) {
      view.nickname = this.nickname;
    }
    if (this.courseTitle) {
      view.courseTitle = this.courseTitle;
    }
    if (this.sessionTitle) {
      view.sessionTitle = this.sessionTitle;
    }
    const notice = this.visibleNotice();
    if (notice) {
      view.notice = notice;
    }
    if (this.projectFolder) {
      view.projectFolder = this.projectFolder;
    } else {
      view.installNotice = INSTALL_UNAVAILABLE;
    }
    if (this.folderError) {
      view.folderError = this.folderError;
    }
    if (this.catalog) {
      view.catalog = this.catalog;
      const installed = this.installedActions.get(this.projectFolder ?? "");
      view.installedActionIds = this.catalog.actions
        .filter((action) => installed?.get(action.id) === action.command)
        .map((action) => action.id);
    }
    if (this.catalogError) {
      view.catalogError = this.catalogError;
    }
    if (this.pendingCommand) {
      view.pendingCommand = this.pendingCommand;
    }
    if (this.commandOutput !== undefined) {
      view.commandOutput = this.commandOutput;
    }
    if (this.commandSucceeded !== undefined) view.commandSucceeded = this.commandSucceeded;
    if (this.mode === "classroom" && this.modelIds[0]) {
      view.modelId = this.modelIds[0];
    }
    if (this.environmentNotice) {
      view.environmentNotice = this.environmentNotice;
    }
    if (this.mustRestart.length > 0) {
      view.mustRestart = [...this.mustRestart];
    }
    let rendered = JSON.stringify(view);
    for (const key of this.hiddenKeys) {
      rendered = rendered.split(JSON.stringify(key).slice(1, -1)).join("[redacted]");
    }
    return JSON.parse(rendered) as ClassroomAppView;
  }

  async checkEnvironment(): Promise<void> {
    if (this.commandRunning) {
      return;
    }
    for (const tool of ENVIRONMENT_TOOLS) {
      let installed = false;
      try {
        installed = (await this.deps.environment.probe(tool)).installed;
      } catch {
        installed = false;
      }
      this.environmentInstalled[tool] = installed;
    }
  }

  selectEnvironment(tools: readonly EnvironmentToolId[]): void {
    if (this.commandRunning) {
      return;
    }
    this.environmentSelected = new Set(
      ENVIRONMENT_TOOLS.filter((id) => tools.includes(id)),
    );
  }

  async confirmEnvironment(): Promise<void> {
    if (this.commandRunning || !this.projectFolder) {
      return;
    }
    const selected = ENVIRONMENT_TOOLS.filter((id) =>
      this.environmentSelected.has(id),
    );
    if (selected.length === 0) {
      return;
    }
    const cwd = this.projectFolder;
    this.commandRunning = true;
    this.environmentNotice = undefined;
    let succeeded = false;
    try {
      for (const tool of selected) {
        let result: { exitCode: number | undefined; output: string };
        try {
          result = await this.deps.environment.install(tool, cwd);
        } catch {
          break;
        }
        if (!environmentInstallSucceeded(result)) {
          break;
        }
        succeeded = true;
      }
    } finally {
      this.commandRunning = false;
    }
    if (succeeded) {
      this.environmentNotice = REOPEN_TERMINAL;
    }
  }

  private environmentTools(): EnvironmentToolView[] {
    return ENVIRONMENT_TOOLS.map((id) => ({
      id,
      label: ENVIRONMENT_LABEL[id],
      installed: this.environmentInstalled[id],
      selected: this.environmentSelected.has(id),
    }));
  }

  async copilotRequest(selection: string): Promise<void> {
    if (selection !== "VCRouter") {
      return;
    }
    if (!this.proxyRunning) {
      throw new Error("VCRouter 目前無法使用。請先啟動 Classroom App。");
    }
    await this.deps.proxy.receive({ provider: "VCRouter" });
    const upstream = await this.classroomUpstream("copilot");
    if (!upstream) {
      return;
    }
    await this.deps.send(upstream);
  }

  async forward(request: ClientForward): Promise<ForwardedRecord> {
    if (!this.proxyRunning) {
      throw new Error(
        request.client === "copilot"
          ? "VCRouter 目前無法使用。請先啟動 Classroom App。"
          : "代理沒有在跑。",
      );
    }
    if (request.client === "copilot") {
      await this.deps.proxy.receive({ provider: "VCRouter" });
      const upstream = await this.classroomUpstream("copilot", request.model);
      if (!upstream) {
        throw new Error("沒有上課模型。");
      }
      await this.deps.send(withHttp(upstream, request));
      return forwardedRecord(upstream);
    }
    if (this.mode === "classroom") {
      const upstream = await this.classroomUpstream(request.client, request.model);
      if (!upstream) {
        throw new Error("沒有上課模型。");
      }
      await this.deps.send(withHttp(upstream, request));
      return forwardedRecord(upstream);
    }
    const target: UpstreamTarget =
      request.client === "codex" ? "chatgpt" : "claude.ai";
    const upstream: UpstreamSend = {
      client: request.client,
      target,
      model: request.model,
    };
    await this.deps.send(withHttp(upstream, request));
    return forwardedRecord(upstream);
  }

  private async classroomUpstream(
    client: ProxyClient,
    requested?: string,
  ): Promise<UpstreamSend | undefined> {
    const apiKey = (await this.deps.storage.getConnection())?.apiKey;
    const model = this.classroomModel(client, requested);
    if (!apiKey || !model) {
      return undefined;
    }
    return { client, target: "router", model, apiKey };
  }

  private classroomModel(
    client: ProxyClient,
    requested: string | undefined,
  ): string | undefined {
    const first = this.modelIds[0];
    if (!first) {
      return undefined;
    }
    const id = requested?.startsWith("VCRouter/")
      ? requested.slice("VCRouter/".length)
      : requested;
    if (id && this.modelIds.includes(id)) {
      this.sending.set(client, id);
      this.modelNotice.delete(client);
      return id;
    }
    if (id && !this.modelIds.includes(id)) {
      this.modelNotice.add(client);
      return first;
    }
    return this.sending.get(client) ?? first;
  }

  private visibleNotice(): string | undefined {
    const parts: string[] = [];
    if (this.notice) {
      parts.push(this.notice);
    }
    if (this.modelNotice.size > 0) {
      parts.push(MODEL_SUBSTITUTED);
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  private forgetModelChoices(): void {
    this.sending.clear();
    this.modelNotice.clear();
  }

  private async publishModelOptions(): Promise<void> {
    const first = this.modelIds[0];
    if (!first || this.mode !== "classroom") {
      await this.restoreModelOptions();
      return;
    }
    const options: ModelOptions = {
      ids: [...this.modelIds],
      codexModel: this.sending.get("codex") ?? first,
      claudeModel: this.sending.get("claude") ?? first,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      restartCodex: true,
    };
    await this.deps.routes.setModelOptions(options);
  }

  private async restoreModelOptions(): Promise<void> {
    await this.deps.routes.setModelOptions(null);
  }

  prepare(actionId: string): void {
    if (this.commandRunning || !this.projectFolder) {
      return;
    }
    const action = this.catalog?.actions.find((item) => item.id === actionId);
    if (!action) {
      return;
    }
    this.pendingCommand = action.command;
    this.pendingActionId = action.id;
    this.commandOutput = undefined;
    this.commandSucceeded = undefined;
  }

  async confirm(): Promise<void> {
    if (this.commandRunning || !this.projectFolder || !this.pendingCommand) {
      return;
    }
    const cwd = this.projectFolder;
    const command = this.pendingCommand;
    const actionId = this.pendingActionId;
    this.commandRunning = true;
    this.commandOutput = undefined;
    this.commandSucceeded = undefined;
    try {
      const result = await this.deps.commands.run(cwd, command, (output) => {
        this.commandOutput = output;
      });
      this.commandOutput = result.output;
      this.commandSucceeded = result.exitCode === 0;
      if (this.commandSucceeded && actionId) {
        let installed = this.installedActions.get(cwd);
        if (!installed) {
          installed = new Map();
          this.installedActions.set(cwd, installed);
        }
        installed.set(actionId, command);
      }
    } catch {
      this.commandOutput = "指令執行失敗。";
      this.commandSucceeded = false;
    } finally {
      this.pendingCommand = undefined;
      this.pendingActionId = undefined;
      this.commandRunning = false;
    }
  }

  cancel(): void {
    if (this.commandRunning) {
      return;
    }
    this.pendingCommand = undefined;
    this.pendingActionId = undefined;
  }

  async redeem(inviteCode: string, nickname: string): Promise<void> {
    const invite = inviteCode.trim();
    const name = nickname.trim();
    if (!invite || !name) {
      this.detail = "請先輸入邀請碼與課堂暱稱，再按「連線」。";
      this.notice = undefined;
      return;
    }
    let redeemed: NicknameRedeemResult;
    try {
      redeemed = await this.deps.router.redeemNickname({
        invite_code: invite,
        nickname: name,
      });
    } catch {
      if (!this.connected) {
        this.detail = "兌換失敗。請檢查邀請碼與課堂暱稱。";
        this.notice = undefined;
      }
      return;
    }
    await this.deps.storage.setConnection({
      version: 1, apiKey: redeemed.api_key, session: redeemed.session, nickname: name, mode: this.mode,
    }, { allowTemporary: true });
    this.hiddenKeys.add(redeemed.api_key);
    const label = [redeemed.session.class_name, redeemed.session.name]
      .filter(Boolean)
      .join(" · ");
    this.classLabel = label || undefined;
    this.nickname = name;
    this.courseTitle = redeemed.session.class_name || undefined;
    this.sessionTitle = redeemed.session.name || undefined;
    this.connected = true;
    this.detail = "Classroom API Key 已設定。";
    this.notice = undefined;
    await this.loadCatalog();
    await this.loadModels(redeemed.api_key);
  }

  async setProjectFolder(folder: string): Promise<void> {
    if (this.commandRunning) {
      return;
    }
    const next = folder.trim();
    this.folderError = undefined;
    this.projectFolder = next || undefined;
    if (!this.remoteCatalogHeld) {
      await this.loadCatalog();
    }
  }

  rejectProjectFolder(): void {
    this.folderError = "這不是資料夾。";
  }

  async setSwitch(mode: ModelSwitchMode): Promise<void> {
    if (mode === "native") {
      if (!await this.saveMode("native")) return;
      this.mode = "native";
      this.forgetModelChoices();
      await this.restoreModelOptions();
      return;
    }
    if (!this.connected || this.modelIds.length === 0) {
      this.mode = "native";
      this.forgetModelChoices();
      await this.restoreModelOptions();
      return;
    }
    if (!await this.saveMode("classroom")) return;
    const entering = this.mode !== "classroom";
    this.mode = "classroom";
    if (entering) {
      this.forgetModelChoices();
    }
    await this.publishModelOptions();
  }

  private async saveMode(mode: ModelSwitchMode): Promise<boolean> {
    try {
      const connection = await this.deps.storage.getConnection();
      if (connection) await this.deps.storage.setConnection({ ...connection, mode }, { allowTemporary: false });
      this.notice = undefined;
      return true;
    } catch {
      this.notice = "無法儲存模型模式。已保留原本模式，請稍後再試。";
      return false;
    }
  }

  async reloadCatalog(): Promise<void> {
    await this.loadCatalog();
  }

  async reloadAllowlist(): Promise<void> {
    const apiKey = (await this.deps.storage.getConnection())?.apiKey;
    if (!apiKey) {
      return;
    }
    await this.loadModels(apiKey);
  }

  private async loadModels(apiKey: string): Promise<void> {
    let ids: string[];
    try {
      ids = await this.deps.router.fetchSessionModels(apiKey);
    } catch {
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || !id.trim())) {
      this.modelIds = [];
      this.mode = "native";
      this.forgetModelChoices();
      await this.restoreModelOptions();
      return;
    }
    const previous = this.modelIds;
    const changed = previous.join("\0") !== ids.join("\0");
    if (changed) {
      this.modelNotice.clear();
    }
    this.modelIds = ids;
    if (!changed || this.mode !== "classroom") {
      return;
    }
    for (const client of PROXY_CLIENTS) {
      const current = this.sending.get(client);
      if (!current || ids.includes(current)) {
        continue;
      }
      this.sending.delete(client);
      this.modelNotice.add(client);
    }
    await this.publishModelOptions();
  }

  async copyKey(): Promise<void> {
    const apiKey = (await this.deps.storage.getConnection())?.apiKey;
    if (!apiKey) {
      this.notice = "無法複製 Classroom API Key。請重新連線後再試。";
      return;
    }
    try {
      await this.deps.clipboard.write(apiKey);
    } catch {
      this.notice = "無法複製 Classroom API Key。請重新連線後再試。";
      return;
    }
    this.notice = "已複製 Classroom API Key。請勿分享給不信任的人。";
  }

  async copySnippet(snippetId: string): Promise<boolean> {
    const snippet = this.catalog?.snippets?.find((item) => item.id === snippetId);
    if (!snippet) return false;
    try {
      await this.deps.clipboard.write(snippet.body);
      return true;
    } catch {
      return false;
    }
  }

  async clearConnection(): Promise<void> {
    await this.deps.storage.clearConnection();
    this.connected = false;
    this.classLabel = undefined;
    this.nickname = undefined;
    this.courseTitle = undefined;
    this.sessionTitle = undefined;
    this.detail = "";
    this.notice = undefined;
    this.catalog = undefined;
    this.catalogError = undefined;
    this.remoteCatalogHeld = false;
    this.mode = "native";
    this.modelIds = [];
    this.forgetModelChoices();
    await this.restoreModelOptions();
  }

  async start(): Promise<void> {
    if (!this.initialization) this.initialization = this.restoreConnection();
    await this.initialization;
    const codex = await this.deps.routes.readCodex();
    const claude = await this.deps.routes.readClaudeTerminal();
    const vsCode = await this.deps.routes.readVsCodeClaude();
    const url = this.deps.proxyBaseUrl;
    const hosts = previousHosts(url, [
      codex.openai_base_url,
      claude.ANTHROPIC_BASE_URL,
      ...anthropicBaseValues(vsCode[VS_CODE_ENV]),
    ]);
    await this.deps.routes.writeCodex({
      ...codex,
      openai_base_url: codexBaseUrl(url),
    });
    await this.deps.routes.writeClaudeTerminal({
      ...claude,
      ANTHROPIC_BASE_URL: url,
    });
    await this.deps.routes.writeVsCodeClaude(withVsCodeBaseUrl(vsCode, url));
    const doc = await this.deps.copilot.read();
    const providers = Array.isArray(doc.providers) ? doc.providers : [];
    const already = providers.some((provider) => provider?.name === "VCRouter");
    this.deps.proxy.start();
    this.proxyRunning = true;
    if (hosts.length > 0) {
      this.notice = `路由原先指向 ${hosts.join("、")}。`;
    }
    if (!this.routeRestartNoted) {
      this.noteRestart("codex");
      this.noteRestart("claude");
      this.routeRestartNoted = true;
    }
    if (this.mode === "classroom") {
      await this.publishModelOptions();
    } else {
      await this.restoreModelOptions();
    }
    if (!already) {
      await this.deps.copilot.write({
        providers: [
          ...providers,
          { name: "VCRouter", url },
        ],
      });
      this.noteRestart("vscode");
    }
  }

  private async restoreConnection(): Promise<void> {
    if (this.connected) return;
    let connection;
    try { connection = await this.deps.storage.getConnection(); }
    catch (error) {
      this.detail = error instanceof StorageError ? error.message : "課堂連線無法讀取。請重新連線。";
      return;
    }
    if (!connection) return;
    this.hiddenKeys.add(connection.apiKey);
    this.classLabel = [connection.session.class_name, connection.session.name].filter(Boolean).join(" · ") || undefined;
    this.courseTitle = connection.session.class_name || undefined;
    this.sessionTitle = connection.session.name || undefined;
    this.nickname = connection.nickname;
    this.connected = true;
    this.detail = "Classroom API Key 已設定。";
    this.mode = "native";
    await this.loadCatalog();
    await this.loadModels(connection.apiKey);
    if (connection.mode === "classroom" && this.modelIds.length > 0) {
      this.mode = "classroom";
    }
  }

  async stop(): Promise<void> {
    this.proxyRunning = false;
    this.deps.proxy.stop();
    const codex = await this.deps.routes.readCodex();
    const claude = await this.deps.routes.readClaudeTerminal();
    const vsCode = await this.deps.routes.readVsCodeClaude();
    await this.deps.routes.writeCodex(withoutKey(codex, "openai_base_url"));
    await this.deps.routes.writeClaudeTerminal(
      withoutKey(claude, "ANTHROPIC_BASE_URL"),
    );
    await this.deps.routes.writeVsCodeClaude(withoutVsCodeBaseUrl(vsCode));
    await this.restoreModelOptions();
  }

  private noteRestart(client: MustRestartClient): void {
    if (!this.mustRestart.includes(client)) {
      this.mustRestart.push(client);
    }
  }

  closeWindow(): void {
    // 關分頁不停止代理，也不改路由。
  }

  private async loadCatalog(): Promise<void> {
    if (!this.connected) {
      return;
    }
    const apiKey = (await this.deps.storage.getConnection())?.apiKey;
    if (!apiKey) {
      this.catalog = undefined;
      this.catalogError = undefined;
      this.remoteCatalogHeld = false;
      return;
    }
    let body: { course_catalog_yaml?: unknown };
    try {
      body = await this.deps.catalog.fetchCourseCatalog(apiKey);
    } catch {
      await this.loadLocalCatalog();
      return;
    }
    const yaml = usableCatalogYaml(body?.course_catalog_yaml);
    if (yaml === undefined) {
      await this.loadLocalCatalog();
      return;
    }
    const parsed = parseCourseCatalog(yaml);
    if (!parsed.ok) {
      await this.loadLocalCatalog();
      return;
    }
    this.catalog = catalogView(parsed.actions, parsed.snippets, "remote");
    this.catalogError = undefined;
    this.remoteCatalogHeld = true;
  }

  private async loadLocalCatalog(): Promise<void> {
    this.remoteCatalogHeld = false;
    if (!this.projectFolder) {
      this.catalog = undefined;
      this.catalogError = "遠端清單不可用。";
      return;
    }
    let text: string | undefined;
    try {
      text = await this.deps.projectFiles.readClassroomInstalls(this.projectFolder);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      this.catalog = undefined;
      this.catalogError = "找不到 classroom-installs.yaml";
      return;
    }
    const parsed = parseCourseCatalog(text);
    if (!parsed.ok) {
      this.catalog = undefined;
      this.catalogError = parsed.error;
      return;
    }
    this.catalog = catalogView(parsed.actions, parsed.snippets, "local");
    this.catalogError = undefined;
  }
}

function hostnameOf(value: string): string | undefined {
  try {
    const host = new URL(value).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

function codexBaseUrl(proxyBaseUrl: string): string {
  return proxyBaseUrl.endsWith("/v1") ? proxyBaseUrl : `${proxyBaseUrl}/v1`;
}

function sameProxy(value: string, proxyBaseUrl: string): boolean {
  try {
    return new URL(value).origin === new URL(proxyBaseUrl).origin;
  } catch {
    return false;
  }
}

function previousHosts(proxyBaseUrl: string, values: unknown[]): string[] {
  const hosts: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || sameProxy(value, proxyBaseUrl)) {
      continue;
    }
    const host = hostnameOf(value);
    if (host && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

function withoutKey(
  doc: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const next = { ...doc };
  delete next[key];
  return next;
}

function environmentInstallSucceeded(result: {
  exitCode: number | undefined;
  output: string;
}): boolean {
  if (result.exitCode === 0) {
    return true;
  }
  if (typeof result.exitCode !== "number") {
    return false;
  }
  return (
    /already installed/i.test(result.output) ||
    /no available upgrade found/i.test(result.output)
  );
}

function usableCatalogYaml(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value;
}

function withHttp(upstream: UpstreamSend, request: ClientForward): UpstreamSend {
  const next: UpstreamSend = { ...upstream };
  if (request.method !== undefined) {
    next.method = request.method;
  }
  if (request.path !== undefined) {
    next.path = request.path;
  }
  if (request.body !== undefined) {
    next.body = request.body;
  }
  return next;
}

function forwardedRecord(upstream: UpstreamSend): ForwardedRecord {
  return {
    client: upstream.client,
    target: upstream.target,
    model: upstream.model,
  };
}

function catalogView(
  actions: CourseCatalogView["actions"],
  snippets: NonNullable<CourseCatalogView["snippets"]>,
  source: "remote" | "local",
): CourseCatalogView {
  const view: CourseCatalogView = { source, actions };
  if (snippets.length > 0) {
    view.snippets = snippets;
  }
  if (source === "local") {
    view.localNote = LOCAL_LIST_NOTE;
  }
  return view;
}
