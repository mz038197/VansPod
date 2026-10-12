import { isClassroomConnection, type ClassroomConnection, type ConnectionStorage } from "./secureStorage";
import { StorageError } from "./storageErrors";
import { defaultAdapters, isAdapterChoice, type AdapterSettings, type AdapterSettingsStorage } from "./adapterSettings";
import type { AdapterClient, AdapterId } from "./adapters";
import {
  defaultClientRoutes,
  type ClientRoutes,
  type ClientRouteSettingsStorage,
} from "./clientRoutes";
import type { ClientRouteRuntime } from "./clientRouteRuntime";
import type { VsCodeProvider, VsCodeRouteSettings } from "./vsCodeRouteSettings";
import { isDeepStrictEqual } from "node:util";
import {
  parseCourseCatalog,
  type InstallAction,
  type LessonSnippet,
} from "./courseCatalog";
import type { CommandResult } from "./commandRunner";
import {
  VS_CODE_ENV,
  anthropicBaseValues,
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
export type ClientModes = Record<AdapterClient, ModelSwitchMode>;
type ClientControl = AdapterClient | "vscode";

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
  detectClient?(client: AdapterClient | "vsCodeChat"): Promise<boolean>;
  adapterSettings?: AdapterSettingsStorage;
  clientRouteSettings?: ClientRouteSettingsStorage;
  clientRouteRuntime?: ClientRouteRuntime;
  vsCodeRouteSettings?: VsCodeRouteSettings;
  router: {
    redeemNickname(body: {
      invite_code: string;
      nickname: string;
    }): Promise<NicknameRedeemResult>;
    fetchSessionModels(apiKey: string): Promise<string[] | VsCodeProvider[]>;
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
    setCodexRoute(classroom: boolean, proxyBaseUrl: string): Promise<void>;
    setClaudeRoute(classroom: boolean, proxyBaseUrl: string): Promise<void>;
    setClaudeCodeRoute(classroom: boolean, proxyBaseUrl: string): Promise<void>;
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
  adapter?: AdapterId;
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
  adapters?: AdapterSettings;
  adapterNotice?: string;
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
  clientModes?: ClientModes;
  clientRoutes?: ClientRoutes;
  detectedClients?: Record<AdapterClient, boolean>;
  allowedModels?: string[];
  modelId?: string;
  tools: EnvironmentToolView[];
  environmentNotice?: string;
  mustRestart?: MustRestartClient[];
  modelRestart?: MustRestartClient[];
  connectionError?: string;
  connectionNotice?: string;
  connectionDraft?: { inviteCode: string; nickname: string };
};

const LOCAL_LIST_NOTE = "這是本機清單。";
const INSTALL_UNAVAILABLE = "尚未指定專案資料夾，安裝不可用。";
const REOPEN_TERMINAL = "請重開終端機再重新檢查。";
const MODEL_SUBSTITUTED = "正在用的模型不在清單裡，已改送第一個。";
const PROXY_CLIENTS: ProxyClient[] = ["codex", "claude", "copilot"];
export class ClassroomApp {
  private adapters = defaultAdapters();
  private clientRoutes = defaultClientRoutes();
  private readonly clientRouteOrigins: Partial<Record<"codex" | "claudeCode", string>> = {};
  private adapterNotice: string | undefined;
  private readonly hiddenKeys = new Set<string>();
  private initialization: Promise<void> | undefined;
  private connectionOperations: Promise<unknown> = Promise.resolve();
  private connected = false;
  private classLabel: string | undefined;
  private nickname: string | undefined;
  private courseTitle: string | undefined;
  private sessionTitle: string | undefined;
  private detail = "";
  private connectionError: string | undefined;
  private connectionNotice: string | undefined;
  private connectionDraft: { inviteCode: string; nickname: string } | undefined;
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
  private clientModes: ClientModes = { codex: "native", claude: "native" };
  private detectedClients = { codex: false, claude: false, vsCodeChat: false };
  // Legacy shared operations still reset both clients; aggregate mode keeps old connections readable.
  private get mode(): ModelSwitchMode {
    return Object.values(this.clientModes).includes("classroom") ? "classroom" : "native";
  }
  private set mode(mode: ModelSwitchMode) { this.clientModes = { codex: mode, claude: mode }; }
  private modelIds: string[] = [];
  private modelProviders: VsCodeProvider[] = [];
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
  private modelRestart: MustRestartClient[] = [];
  private routeRestartNoted = false;
  private vsCodeOrigin: string | undefined;
  private sending = new Map<ProxyClient, string>();
  private modelNotice = new Set<ProxyClient>();

  constructor(private readonly deps: ClassroomAppDeps) {}

  private serialConnectionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.connectionOperations.then(operation, operation);
    this.connectionOperations = next.catch(() => {});
    return next;
  }

  view(): ClassroomAppView {
    const view: ClassroomAppView = {
      connected: this.connected,
      detail: this.detail,
      canCopyKey: this.connected,
      installAvailable: Boolean(this.projectFolder),
      commandRunning: this.commandRunning,
      mode: this.mode,
      clientModes: { ...this.clientModes },
      clientRoutes: this.clientRouteView(),
      detectedClients: { codex: this.detectedClients.codex, claude: this.detectedClients.claude },
      allowedModels: [...this.modelIds],
      adapters: { ...this.adapters },
      adapterNotice: this.adapterNotice,
      tools: this.environmentTools(),
    };
    if (this.connectionError) view.connectionError = this.connectionError;
    if (this.notice && this.notice === this.connectionNotice) view.connectionNotice = this.connectionNotice;
    if (this.connectionDraft && !this.connected) view.connectionDraft = { ...this.connectionDraft };
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
    if (this.modelRestart.length > 0) view.modelRestart = [...this.modelRestart];
    let rendered = JSON.stringify(view);
    for (const key of this.hiddenKeys) {
      rendered = rendered.split(JSON.stringify(key).slice(1, -1)).join("[redacted]");
    }
    return JSON.parse(rendered) as ClassroomAppView;
  }

  private redactSecrets(value: string): string {
    let redacted = value;
    for (const key of this.hiddenKeys) redacted = redacted.split(key).join("[redacted]");
    return redacted;
  }

  private clientRouteView(): ClientRoutes {
    return {
      codex: { ...this.clientRoutes.codex },
      claudeCode: { ...this.clientRoutes.claudeCode },
      vsCodeChat: { ...this.clientRoutes.vsCodeChat },
    };
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
    const upstream = await this.serialConnectionOperation(() => this.copilotUpstream(selection));
    if (upstream) await this.deps.send(upstream);
  }

  private async copilotUpstream(selection: string): Promise<UpstreamSend | undefined> {
    if (selection !== "VCRouter") {
      return;
    }
    if (!this.proxyRunning) {
      throw new Error("VCRouter 目前無法使用。請先啟動 VansPod。");
    }
    await this.deps.proxy.receive({ provider: "VCRouter" });
    return this.classroomUpstream("copilot");
  }

  async forward(request: ClientForward): Promise<ForwardedRecord> {
    // Only select a coherent connection and permissions under the lock; streaming stays concurrent.
    const upstream = await this.serialConnectionOperation(() => this.forwardUpstream(request));
    await this.deps.send(withHttp(upstream, request));
    if (this.deps.clientRouteRuntime && request.client !== "copilot" && this.clientModes[request.client] === "classroom") {
      const route = request.client === "codex" ? this.clientRoutes.codex : this.clientRoutes.claudeCode;
      route.health = "green";
      route.restart = "ready";
    }
    if (this.deps.clientRouteRuntime && request.client === "copilot" && this.clientRoutes.vsCodeChat.mode === "classroom") {
      this.clientRoutes.vsCodeChat.health = "green";
      this.clientRoutes.vsCodeChat.restart = "ready";
    }
    return forwardedRecord(upstream);
  }

  private async forwardUpstream(request: ClientForward): Promise<UpstreamSend> {
    if (this.deps.clientRouteRuntime && !this.proxyRunning) {
      if (request.client === "codex" && this.clientRoutes.codex.health === "red") {
        throw new Error("Codex Client Route 尚未恢復。請重開 Codex 後再試。");
      }
      if (request.client === "claude" && this.clientRoutes.claudeCode.health === "red") {
        throw new Error("Claude Code Client Route 尚未恢復。請重開 Claude Code CLI 後再試。");
      }
      if (request.client === "copilot" && this.clientRoutes.vsCodeChat.health === "red") {
        throw new Error("VS Code Client Route 尚未恢復。請重開 VS Code 後再試。");
      }
    }
    if (!this.proxyRunning) {
      throw new Error(
        request.client === "copilot"
          ? "VCRouter 目前無法使用。請先啟動 VansPod。"
          : "代理沒有在跑。",
      );
    }
    if (request.client === "copilot") {
      if (this.deps.clientRouteRuntime && this.clientRoutes.vsCodeChat.mode === "native") {
        throw new Error("VS Code 已切回 Native。請重開 VS Code 後再試。");
      }
      await this.deps.proxy.receive({ provider: "VCRouter" });
      const upstream = await this.classroomUpstream("copilot", request.model);
      if (!upstream) {
        throw new Error("沒有上課模型。");
      }
      return upstream;
    }
    if (request.client === "codex" && this.deps.clientRouteRuntime && this.clientModes.codex === "native") {
      throw new Error("Codex 已切回 Native。請重開 Codex 後再試。");
    }
    if (request.client === "claude" && this.deps.clientRouteRuntime && this.clientModes.claude === "native") {
      throw new Error("Claude Code 已切回 Native。請重開 Claude Code CLI 後再試。");
    }
    if (this.clientModes[request.client] === "classroom") {
      if (request.client === "claude" && this.deps.clientRouteRuntime &&
        (!request.model || !this.modelIds.includes(request.model))) {
        throw new Error(`模型 ${request.model || "(missing)"} 不在課堂允許清單。`);
      }
      const upstream = await this.classroomUpstream(request.client, request.model);
      if (!upstream) {
        throw new Error("沒有上課模型。");
      }
      return upstream;
    }
    const target: UpstreamTarget =
      request.client === "codex" ? "chatgpt" : "claude.ai";
    const upstream: UpstreamSend = {
      client: request.client,
      target,
      model: request.model,
    };
    return upstream;
  }

  private async classroomUpstream(
    client: ProxyClient,
    requested?: string,
  ): Promise<UpstreamSend | undefined> {
    if (!this.connected) return undefined;
    let apiKey: string | undefined;
    try { apiKey = (await this.deps.storage.getConnection())?.apiKey; }
    catch { return undefined; }
    const model = this.classroomModel(client, requested);
    if (!apiKey || !model) {
      return undefined;
    }
    return {
      client,
      target: "router",
      model,
      apiKey,
      adapter: client === "copilot" ? this.clientRoutes.vsCodeChat.adapter : this.adapters[client],
    };
  }

  async setAdapter(client: ClientControl, id: string): Promise<void> {
    if (client === "vscode") {
      if (id !== "responses" && id !== "chat") throw new Error("無效的 VS Code adapter。");
      await this.serialConnectionOperation(() => this.setVsCodeAdapter(id));
      return;
    }
    if (!isAdapterChoice(client, id)) throw new Error(`無效的 ${client === "codex" ? "Codex" : "Claude Code"} adapter。`);
    await this.serialConnectionOperation(async () => {
      if (client === "codex" && this.deps.clientRouteRuntime) {
        if (this.clientRoutes.codex.health === "red" || this.clientRoutes.codex.health === "gray") {
          this.adapterNotice = "Codex Client Route 目前無法變更 adapter。";
          return;
        }
        const previous = this.clientRoutes.codex.adapter;
        this.clientRoutes.codex.adapter = id;
        try { await this.saveClientRoutePreferences(); }
        catch {
          this.clientRoutes.codex.adapter = previous;
          this.adapterNotice = "無法儲存 adapter 選擇，已保留原本設定。";
          return;
        }
        this.adapters = { ...this.adapters, codex: id === "messages" ? "responses" : id };
        if (this.clientRoutes.codex.mode === "classroom") {
          this.clientRoutes.codex.health = "yellow";
          this.clientRoutes.codex.restart = "restart-required";
        }
        this.adapterNotice = undefined;
        return;
      }
      if (client === "claude" && this.deps.clientRouteRuntime) {
        const route = this.clientRoutes.claudeCode;
        if (route.health === "red" || route.health === "gray") {
          this.adapterNotice = "Claude Code Client Route 目前無法變更 adapter。";
          return;
        }
        const previous = route.adapter;
        route.adapter = id;
        try { await this.saveClientRoutePreferences(); }
        catch {
          route.adapter = previous;
          this.adapterNotice = "無法儲存 adapter 選擇，已保留原本設定。";
          return;
        }
        this.adapters = { ...this.adapters, claude: id };
        if (route.mode === "classroom") {
          route.health = "yellow";
          route.restart = "restart-required";
        }
        this.adapterNotice = undefined;
        return;
      }
      if (this.clientModes[client] !== "classroom") {
        this.adapterNotice = "請先將這個客戶端切換到課堂模式。";
        return;
      }
      const next = { ...this.adapters, [client]: id } as AdapterSettings;
      try { await this.deps.adapterSettings?.save(next); }
      catch { this.adapterNotice = "無法儲存 adapter 選擇，已保留原本設定。"; return; }
      this.adapters = next;
      this.adapterNotice = undefined;
    });
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

  private async publishModelOptions(updateClient?: AdapterClient): Promise<void> {
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
      clients: {
        codex: this.clientModes.codex === "classroom",
        claude: !this.deps.clientRouteRuntime && this.clientModes.claude === "classroom",
      },
      updateClient,
    };
    if (updateClient !== "claude") await this.deps.routes.setCodexRoute(this.clientModes.codex === "classroom", this.deps.proxyBaseUrl);
    if (!this.deps.clientRouteRuntime && updateClient !== "codex") {
      await this.deps.routes.setClaudeRoute(this.clientModes.claude === "classroom", this.deps.proxyBaseUrl);
    }
    await this.deps.routes.setModelOptions(options);
  }

  private async restoreModelOptions(): Promise<void> {
    await this.deps.routes.setCodexRoute(false, this.deps.proxyBaseUrl);
    await this.deps.routes.setClaudeRoute(false, this.deps.proxyBaseUrl);
    await this.deps.routes.setModelOptions(null);
  }

  private async restoreCodexRouteSettings(): Promise<void> {
    await this.deps.routes.setCodexRoute(false, this.deps.proxyBaseUrl);
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
    return this.serialConnectionOperation(() => this.redeemNow(inviteCode, nickname));
  }

  private async redeemNow(inviteCode: string, nickname: string): Promise<void> {
    const invite = inviteCode.trim();
    const name = nickname.trim();
    this.connectionError = undefined;
    this.connectionDraft = { inviteCode, nickname };
    if (!invite || !name) {
      this.connectionError = "請先輸入邀請碼與課堂暱稱，再按「連線」。";
      if (!this.connected) this.detail = "";
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
        this.connectionError = "連線失敗，請確認邀請碼與課堂暱稱後再試。";
        this.detail = "";
        this.notice = undefined;
      }
      return;
    }
    const connection = { version: 1 as const, apiKey: redeemed?.api_key, session: redeemed?.session, nickname: name, mode: this.mode, clientModes: { ...this.clientModes } };
    if (!isClassroomConnection(connection)) {
      this.notice = this.connectionNotice = "兌換回應資料格式不正確，已保留原有課堂連線。請稍後再試。";
      return;
    }
    this.hiddenKeys.add(connection.apiKey);
    try {
      await this.deps.storage.setConnection(connection, { allowTemporary: true });
    } catch {
      this.notice = this.connectionNotice = "無法安全保存或清除原有課堂連線，換堂未完成。請稍後再試。";
      return;
    }
    const desiredMode = this.mode;
    const desiredClientModes = { ...this.clientModes };
    const desiredVsCodeMode = this.clientRoutes.vsCodeChat.mode;
    // A committed new session must never inherit permissions or resources from the old one.
    this.mode = "native";
    this.clientRoutes.vsCodeChat.mode = "native";
    this.clientRoutes.vsCodeChat.restart = "ready";
    this.modelIds = [];
    this.modelProviders = [];
    this.forgetModelChoices();
    this.catalog = undefined;
    this.catalogError = undefined;
    this.remoteCatalogHeld = false;
    this.pendingCommand = undefined;
    this.pendingActionId = undefined;
    this.applyConnectionIdentity(connection);
    this.connectionDraft = undefined;
    this.notice = undefined;
    // Storage is committed: publish its identity before any client-file operation can fail.
    if (desiredVsCodeMode === "classroom") {
      try { await this.deps.vsCodeRouteSettings?.restore(); }
      catch {
        this.clientRoutes.vsCodeChat.health = "red";
        try { await this.saveClientRoutePreferences(); } catch { /* Native/red remains authoritative in memory. */ }
        this.notice = this.connectionNotice = "新課堂連線已建立，但無法恢復 VS Code 的 Native 設定。備份已保留，請稍後再試。";
        return;
      }
    }
    try {
      await this.restoreModelOptions();
    } catch {
      this.notice = this.connectionNotice = "新課堂連線已建立，但無法更新模型設定。目前使用 Native，請稍後再試。";
      return;
    }
    await this.loadCatalog();
    await this.loadModels(redeemed.api_key);
    if (desiredMode === "classroom" && this.modelIds.length > 0) {
      this.mode = "classroom";
      this.clientModes = desiredClientModes;
      try {
        await this.publishModelOptions();
      } catch {
        this.mode = "native";
        this.modelIds = [];
        this.forgetModelChoices();
        try { await this.restoreModelOptions(); } catch { /* Keep proxy routing safely Native. */ }
        this.notice = this.connectionNotice = "新課堂連線已建立，但無法更新模型設定。目前使用 Native，請稍後再試。";
      }
    }
    if (desiredVsCodeMode === "classroom" && this.modelIds.length > 0 && this.vsCodeOrigin) {
      this.clientRoutes.vsCodeChat.mode = "classroom";
      try {
        const result = await this.deps.vsCodeRouteSettings?.publish({
          providers: this.modelProviders,
          adapter: this.clientRoutes.vsCodeChat.adapter as "responses" | "chat",
          origin: this.vsCodeOrigin,
        });
        this.clientRoutes.vsCodeChat.health = result?.changed ? "yellow" : "green";
        this.clientRoutes.vsCodeChat.restart = result?.changed ? "restart-required" : "ready";
        if (result?.changed) this.noteModelRestart("vscode");
      } catch (error) {
        this.clientRoutes.vsCodeChat.mode = "native";
        this.clientRoutes.vsCodeChat.health = "red";
        this.clientRoutes.vsCodeChat.restart = "ready";
        this.notice = this.connectionNotice = error instanceof Error ? error.message : "新課堂連線已建立，但無法更新 VS Code 設定。";
      }
      try { await this.saveClientRoutePreferences(); } catch { this.clientRoutes.vsCodeChat.health = "red"; }
    }
  }

  async setProjectFolder(folder: string): Promise<void> {
    return this.serialConnectionOperation(() => this.setProjectFolderNow(folder));
  }

  private async setProjectFolderNow(folder: string): Promise<void> {
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

  async setSwitch(mode: ModelSwitchMode, client?: ClientControl): Promise<void> {
    return this.serialConnectionOperation(() => client ? this.setClientSwitch(mode, client) : this.setSwitchNow(mode));
  }

  private async setClientSwitch(mode: ModelSwitchMode, client: ClientControl): Promise<void> {
    if (client === "vscode") {
      await this.setVsCodeClientRouteSwitch(mode);
      return;
    }
    if (client === "codex" && this.deps.clientRouteRuntime) {
      await this.setCodexClientRouteSwitch(mode);
      return;
    }
    if (client === "claude" && this.deps.clientRouteRuntime) {
      await this.setClaudeCodeClientRouteSwitch(mode);
      return;
    }
    if (mode === "classroom" && (!this.connected || this.modelIds.length === 0)) {
      this.notice = "請先連線到有可用模型的課堂。";
      return;
    }
    const previous = { ...this.clientModes };
    if (previous[client] === mode && mode !== "native") return;
    const next = { ...previous, [client]: mode };
    const aggregate = Object.values(next).includes("classroom") ? "classroom" : "native";
    if (!await this.saveMode(aggregate, next)) return;
    this.clientModes = next;
    this.sending.delete(client);
    this.modelNotice.delete(client);
    try {
      await this.publishModelOptions(client);
      this.notice = undefined;
      if (!this.modelRestart.includes(client)) this.modelRestart.push(client);
      this.adapterNotice = undefined;
    } catch {
      this.clientModes = previous;
      let restored = true;
      try { await this.publishModelOptions(client); } catch {
        restored = false;
        this.mode = "native";
        try { await this.restoreModelOptions(); } catch { /* Surface partial recovery below. */ }
      }
      const persisted = await this.saveMode(this.mode, this.clientModes);
      this.notice = "無法更新客戶端模型設定，請稍後再試。" +
        (restored ? " 已保留原本模式。" : " 目前使用個人模式，部分客戶端設定需要重新檢查。") +
        (persisted ? "" : " 無法儲存恢復後的模式，請重試。");
    }
  }

  private async setCodexClientRouteSwitch(mode: ModelSwitchMode): Promise<void> {
    const route = this.clientRoutes.codex;
    if (route.health === "red" || route.health === "gray") {
      this.notice = "Codex Client Route 目前無法切換 Classroom。";
      return;
    }
    if (mode === "classroom" && (!this.connected || this.modelIds.length === 0)) {
      this.notice = "請先連線到有可用模型的課堂。";
      return;
    }
    if (route.mode === mode) return;
    const previousRoute = { ...route };
    const previousModes = { ...this.clientModes };
    route.mode = mode;
    this.clientModes.codex = mode;
    try {
      // Preference persistence and the route-file journal both precede the client write.
      await this.saveClientRoutePreferences();
      const aggregate = Object.values(this.clientModes).includes("classroom") ? "classroom" : "native";
      if (!await this.saveMode(aggregate, this.clientModes)) throw new Error("mode persistence failed");
      await this.publishModelOptions("codex");
      route.health = mode === "classroom" ? "yellow" : "green";
      route.restart = mode === "classroom" ? "restart-required" : "ready";
      route.adapter = this.adapters.codex;
      this.notice = undefined;
      this.adapterNotice = undefined;
    } catch {
      this.clientRoutes.codex = previousRoute;
      this.clientModes = previousModes;
      try { await this.saveClientRoutePreferences(); } catch { /* Keep the rollback visible in memory. */ }
      try { await this.publishModelOptions("codex"); } catch { /* The route remains non-Classroom. */ }
      this.notice = "無法更新 Codex Client Route，已保留原本模式。";
    }
  }

  private async setVsCodeClientRouteSwitch(mode: ModelSwitchMode): Promise<void> {
    const route = this.clientRoutes.vsCodeChat;
    if (route.health === "red" || route.health === "gray") {
      this.notice = "VS Code Chat Client Route 目前無法切換 Classroom。";
      return;
    }
    if (mode === "classroom" && (!this.connected || this.modelIds.length === 0 || !this.vsCodeOrigin)) {
      this.notice = "請先連線到有可用模型的課堂。";
      return;
    }
    if (route.mode === mode) return;
    const previous = { ...route };
    route.mode = mode;
    try {
      await this.saveClientRoutePreferences();
      const result = mode === "classroom"
        ? await this.deps.vsCodeRouteSettings?.publish({ providers: this.modelProviders, adapter: route.adapter as "responses" | "chat", origin: this.vsCodeOrigin! })
        : await this.deps.vsCodeRouteSettings?.restore();
      route.health = mode === "classroom" && result?.changed ? "yellow" : "green";
      route.restart = mode === "classroom" && result?.changed ? "restart-required" : "ready";
      if (result?.changed) this.noteModelRestart("vscode");
      this.notice = undefined;
    } catch (error) {
      this.clientRoutes.vsCodeChat = previous;
      try { await this.saveClientRoutePreferences(); } catch { /* Keep visible state. */ }
      if (String(error).includes("舊擴充") || String(error).includes("ownership") || String(error).includes("其他程式")) {
        this.clientRoutes.vsCodeChat.health = "red";
        this.notice = error instanceof Error ? error.message : "VS Code VCRouter provider 衝突。";
      } else {
        this.notice = "無法更新 VS Code Chat Client Route，已保留原本模式。";
      }
    }
  }

  private async setVsCodeAdapter(id: "responses" | "chat"): Promise<void> {
    const route = this.clientRoutes.vsCodeChat;
    if (route.health === "red" || route.health === "gray") {
      this.adapterNotice = "VS Code Chat Client Route 目前無法變更 adapter。";
      return;
    }
    const previous = route.adapter;
    route.adapter = id;
    try {
      await this.saveClientRoutePreferences();
      if (route.mode === "classroom") {
        const result = await this.deps.vsCodeRouteSettings?.publish({ providers: this.modelProviders, adapter: id, origin: this.vsCodeOrigin! });
        if (result?.changed) {
          route.health = "yellow";
          route.restart = "restart-required";
          this.noteModelRestart("vscode");
        }
      }
      this.adapterNotice = undefined;
    } catch {
      route.adapter = previous;
      try { await this.saveClientRoutePreferences(); } catch { /* Keep rollback in memory. */ }
      this.adapterNotice = "無法更新 VS Code adapter，已保留原本設定。";
    }
  }

  private async setClaudeCodeClientRouteSwitch(mode: ModelSwitchMode): Promise<void> {
    const route = this.clientRoutes.claudeCode;
    if (route.health === "red" || route.health === "gray") {
      this.notice = "Claude Code Client Route 目前無法切換 Classroom。";
      return;
    }
    if (mode === "classroom" && (!this.connected || this.modelIds.length === 0)) {
      this.notice = "請先連線到有可用模型的課堂。";
      return;
    }
    if (route.mode === mode) return;
    const previousRoute = { ...route };
    const previousModes = { ...this.clientModes };
    route.mode = mode;
    this.clientModes.claude = mode;
    try {
      await this.saveClientRoutePreferences();
      const aggregate = Object.values(this.clientModes).includes("classroom") ? "classroom" : "native";
      if (!await this.saveMode(aggregate, this.clientModes)) throw new Error("mode persistence failed");
      await this.deps.routes.setClaudeCodeRoute(mode === "classroom", this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl);
      route.health = mode === "classroom" ? "yellow" : "green";
      route.restart = mode === "classroom" ? "restart-required" : "ready";
      this.notice = undefined;
      this.adapterNotice = undefined;
    } catch {
      this.clientRoutes.claudeCode = previousRoute;
      this.clientModes = previousModes;
      try { await this.saveClientRoutePreferences(); } catch { /* Keep the rollback visible in memory. */ }
      try {
        await this.deps.routes.setClaudeCodeRoute(previousRoute.mode === "classroom", this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl);
      } catch { /* The visible route state remains authoritative. */ }
      this.notice = "無法更新 Claude Code Client Route，已保留原本模式。";
    }
  }

  private async setSwitchNow(mode: ModelSwitchMode): Promise<void> {
    const requested = mode === "classroom" && this.connected && this.modelIds.length > 0 ? "classroom" : "native";
    if (!await this.saveMode(requested)) return;
    const entering = Object.values(this.clientModes).some(mode => mode !== requested);
    this.mode = requested;
    if (entering || requested === "native") this.forgetModelChoices();
    try {
      if (requested === "classroom") await this.publishModelOptions();
      else await this.restoreModelOptions();
      if (entering) this.modelRestart = ["codex", "claude"];
    } catch {
      // Sequential client-file writes may have partially succeeded. Upstream must be safe immediately.
      this.mode = "native";
      this.forgetModelChoices();
      let restored = true;
      try { await this.restoreModelOptions(); } catch { restored = false; }
      const persisted = requested === "native" || await this.saveMode("native");
      this.notice = "無法更新模型設定。目前使用 Native，請稍後再試。" +
        (restored ? "" : " 部分客戶端設定無法恢復，請重試或手動檢查。") +
        (persisted ? "" : " 無法儲存 Native 模式，重新啟動仍可能恢復 Classroom；請重試。");
    }
  }

  private async saveMode(mode: ModelSwitchMode, clientModes: ClientModes = { codex: mode, claude: mode }): Promise<boolean> {
    try {
      const connection = await this.deps.storage.getConnection();
      if (connection) await this.deps.storage.setConnection({ ...connection, mode, clientModes }, { allowTemporary: false });
      this.notice = undefined;
      return true;
    } catch {
      this.notice = "無法儲存模型模式。已保留原本模式，請稍後再試。";
      return false;
    }
  }

  async reloadCatalog(): Promise<void> {
    return this.serialConnectionOperation(() => this.loadCatalog());
  }

  async reloadAllowlist(): Promise<void> {
    await this.detectClients();
    if (this.deps.clientRouteRuntime) {
      await this.startCodexRoute();
      await this.startClaudeCodeRoute();
      await this.startVsCodeRoute();
    }
    return this.serialConnectionOperation(() => this.reloadAllowlistNow());
  }

  private async saveClientRoutePreferences(): Promise<void> {
    await this.deps.clientRouteSettings?.save({
      codex: { mode: this.clientRoutes.codex.mode, adapter: this.clientRoutes.codex.adapter },
      claudeCode: { mode: this.clientRoutes.claudeCode.mode, adapter: this.clientRoutes.claudeCode.adapter },
      vsCodeChat: { mode: this.clientRoutes.vsCodeChat.mode, adapter: this.clientRoutes.vsCodeChat.adapter },
    });
  }

  private async startCodexRoute(): Promise<void> {
    const runtime = this.deps.clientRouteRuntime;
    if (!runtime) return;
    const retryingNativeRecovery = this.clientRoutes.codex.health === "red" && this.clientRoutes.codex.mode === "native";
    let health: "green" | "red" = "red";
    try {
      const started = await runtime.start("codex");
      this.clientRouteOrigins.codex = started.origin;
      health = started.health === "green" ? "green" : "red";
    }
    catch { health = "red"; }
    if (health === "red") {
      this.clientRoutes.codex = { ...this.clientRoutes.codex, mode: "native", health: "red", restart: "ready" };
      this.clientModes.codex = "native";
      try { await this.saveClientRoutePreferences(); } catch { /* The visible red state remains authoritative. */ }
      try { await this.deps.routes.setCodexRoute(false, this.deps.proxyBaseUrl); } catch { /* Retried on reload. */ }
      return;
    }
    if (!this.detectedClients.codex) {
      this.clientRoutes.codex = { ...this.clientRoutes.codex, mode: "native", health: "gray", restart: "ready" };
      this.clientModes.codex = "native";
      return;
    }
    if (this.clientRoutes.codex.mode === "classroom" && (!this.connected || this.modelIds.length === 0)) {
      this.clientRoutes.codex.mode = "native";
      try { await this.saveClientRoutePreferences(); } catch { /* Native remains the safe runtime state. */ }
    }
    if (retryingNativeRecovery) {
      try { await this.restoreCodexRouteSettings(); }
      catch {
        this.clientRoutes.codex.health = "red";
        this.clientRoutes.codex.restart = "ready";
        return;
      }
    }
    // Listener recovery never restores Classroom automatically after a red failure.
    this.clientRoutes.codex.health = "green";
    this.clientRoutes.codex.restart = "ready";
    this.clientModes.codex = this.clientRoutes.codex.mode === "classroom" && this.connected && this.modelIds.length > 0
      ? "classroom"
      : "native";
  }

  private async startVsCodeRoute(): Promise<void> {
    const runtime = this.deps.clientRouteRuntime;
    if (!runtime) return;
    const retryingNativeRecovery = this.clientRoutes.vsCodeChat.health === "red" && this.clientRoutes.vsCodeChat.mode === "native";
    if (!this.detectedClients.vsCodeChat) {
      this.clientRoutes.vsCodeChat = { ...this.clientRoutes.vsCodeChat, mode: "native", health: "gray", restart: "ready" };
      return;
    }
    const alreadyRunning = this.vsCodeOrigin !== undefined &&
      (this.clientRoutes.vsCodeChat.health === "green" || this.clientRoutes.vsCodeChat.health === "yellow") &&
      (runtime.current?.("vsCodeChat")?.health ?? "green") === "green";
    let started;
    try { started = await runtime.start("vsCodeChat"); }
    catch {
      await this.failVsCodeRouteStart();
      return;
    }
    this.vsCodeOrigin = started.origin;
    if (started.health !== "green") {
      await this.failVsCodeRouteStart();
      return;
    }
    if (retryingNativeRecovery) {
      try {
        await this.deps.vsCodeRouteSettings?.restore();
        this.clientRoutes.vsCodeChat.health = "green";
        this.clientRoutes.vsCodeChat.restart = "ready";
      } catch {
        this.clientRoutes.vsCodeChat.health = "red";
        this.clientRoutes.vsCodeChat.restart = "ready";
      }
      return;
    }
    if (alreadyRunning) return;
    try {
      if (this.clientRoutes.vsCodeChat.mode === "classroom" && this.connected && this.modelIds.length > 0) {
        const result = await this.deps.vsCodeRouteSettings?.publish({
          providers: this.modelProviders,
          adapter: this.clientRoutes.vsCodeChat.adapter as "responses" | "chat",
          origin: started.origin,
        });
        this.clientRoutes.vsCodeChat.health = result?.changed ? "yellow" : "green";
        this.clientRoutes.vsCodeChat.restart = result?.changed ? "restart-required" : "ready";
        if (result?.changed) this.noteModelRestart("vscode");
      } else {
        this.clientRoutes.vsCodeChat.mode = "native";
        await this.deps.vsCodeRouteSettings?.initializeNative();
        this.clientRoutes.vsCodeChat.health = "green";
        this.clientRoutes.vsCodeChat.restart = "ready";
      }
    } catch (error) {
      this.clientRoutes.vsCodeChat.mode = "native";
      this.clientRoutes.vsCodeChat.health = "red";
      this.clientRoutes.vsCodeChat.restart = "ready";
      this.notice = error instanceof Error ? error.message : "VS Code Chat Client Route 設定失敗。";
    }
    try { await this.saveClientRoutePreferences(); } catch { /* Route health remains visible. */ }
  }

  private async failVsCodeRouteStart(): Promise<void> {
    try { await this.deps.vsCodeRouteSettings?.restore(); } catch { /* Journal remains available for retry. */ }
    this.clientRoutes.vsCodeChat = { ...this.clientRoutes.vsCodeChat, mode: "native", health: "red", restart: "ready" };
    try { await this.saveClientRoutePreferences(); } catch { /* Visible red state wins. */ }
  }

  private async startClaudeCodeRoute(): Promise<void> {
    const runtime = this.deps.clientRouteRuntime;
    if (!runtime) return;
    const route = this.clientRoutes.claudeCode;
    const retryingNativeRecovery = route.health === "red" && route.mode === "native";
    if (!this.detectedClients.claude) {
      route.mode = "native";
      route.health = "gray";
      route.restart = "ready";
      this.clientModes.claude = "native";
      return;
    }
    const alreadyRunning = runtime.current?.("claudeCode")?.health === "green";
    let health: "green" | "red" = "red";
    try {
      const started = await runtime.start("claudeCode");
      this.clientRouteOrigins.claudeCode = started.origin;
      health = started.health === "green" ? "green" : "red";
    } catch { health = "red"; }
    if (health === "red") {
      route.mode = "native";
      route.health = "red";
      route.restart = "ready";
      this.clientModes.claude = "native";
      try { await this.saveClientRoutePreferences(); } catch { /* The visible red state remains authoritative. */ }
      try { await this.deps.routes.setClaudeCodeRoute(false, this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl); }
      catch { /* Retried on reload. */ }
      return;
    }
    if (route.mode === "classroom" && (!this.connected || this.modelIds.length === 0)) {
      route.mode = "native";
      try { await this.saveClientRoutePreferences(); } catch { /* Native remains the safe runtime state. */ }
    }
    if (retryingNativeRecovery) {
      try {
        await this.deps.routes.setClaudeCodeRoute(false, this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl);
      } catch {
        route.health = "red";
        route.restart = "ready";
        return;
      }
    }
    route.health = "green";
    route.restart = "ready";
    this.clientModes.claude = route.mode === "classroom" && this.connected && this.modelIds.length > 0
      ? "classroom"
      : "native";
    if (alreadyRunning) return;
    try {
      await this.deps.routes.setClaudeCodeRoute(
        this.clientModes.claude === "classroom",
        this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl,
      );
      if (this.clientModes.claude === "classroom") {
        route.health = "yellow";
        route.restart = "restart-required";
      }
    } catch {
      route.mode = "native";
      route.health = "red";
      route.restart = "ready";
      this.clientModes.claude = "native";
      try { await this.saveClientRoutePreferences(); } catch { /* The visible red state remains authoritative. */ }
    }
  }

  private async detectClients(): Promise<void> {
    await Promise.all((["codex", "claude", "vsCodeChat"] as const).map(async client => {
      try { this.detectedClients[client] = await this.deps.detectClient?.(client) ?? false; }
      catch { this.detectedClients[client] = false; }
    }));
  }

  private async reloadAllowlistNow(): Promise<void> {
    if (!this.connected) return;
    const apiKey = (await this.deps.storage.getConnection())?.apiKey;
    if (!apiKey) {
      return;
    }
    const previous = this.mode === "classroom" ? this.modelIds.join("\0") : "";
    await this.loadModels(apiKey);
    const current = this.mode === "classroom" ? this.modelIds.join("\0") : "";
    if (previous !== current) {
      this.modelRestart = (["codex", "claude"] as const).filter(client => this.clientModes[client] === "classroom");
      if (this.deps.clientRouteRuntime && this.clientRoutes.claudeCode.mode === "classroom") {
        this.clientRoutes.claudeCode.health = "yellow";
        this.clientRoutes.claudeCode.restart = "restart-required";
      }
    }
  }

  private async loadModels(apiKey: string): Promise<void> {
    let payload: string[] | VsCodeProvider[];
    try {
      payload = await this.deps.router.fetchSessionModels(apiKey);
    } catch {
      return;
    }
    const items: unknown[] = Array.isArray(payload) ? payload : [];
    const stringPayload = items.every(item => typeof item === "string");
    const providers = stringPayload ? [] : items.filter(
      (item): item is VsCodeProvider => !!item && typeof item === "object" && !Array.isArray(item),
    );
    const ids = providers.length > 0
      ? providers.flatMap(provider => Array.isArray(provider.models) ? provider.models.flatMap(model => {
        const id = model && typeof model === "object" && !Array.isArray(model) ? (model as Record<string, unknown>).id : undefined;
        return typeof id === "string" && id ? [id] : [];
      }) : [])
      : items as string[];
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || !id.trim())) {
      this.modelIds = [];
      this.modelProviders = [];
      this.mode = "native";
      if (this.deps.clientRouteRuntime) {
        this.clientRoutes.codex.mode = "native";
        this.clientRoutes.claudeCode.mode = "native";
        this.clientRoutes.vsCodeChat.mode = "native";
        this.clientRoutes.codex.restart = "ready";
        this.clientRoutes.claudeCode.restart = "ready";
        this.clientRoutes.vsCodeChat.restart = "ready";
        try { await this.saveClientRoutePreferences(); } catch {
          this.clientRoutes.codex.health = "red";
          this.clientRoutes.claudeCode.health = "red";
          this.clientRoutes.vsCodeChat.health = "red";
        }
        try {
          await this.deps.routes.setClaudeCodeRoute(false, this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl);
          if (this.clientRoutes.claudeCode.health !== "red") {
            this.clientRoutes.claudeCode.health = this.detectedClients.claude ? "green" : "gray";
          }
        } catch { this.clientRoutes.claudeCode.health = "red"; }
        try {
          await this.deps.vsCodeRouteSettings?.restore();
          if (this.clientRoutes.vsCodeChat.health !== "red") {
            this.clientRoutes.vsCodeChat.health = this.detectedClients.vsCodeChat ? "green" : "gray";
          }
        } catch { this.clientRoutes.vsCodeChat.health = "red"; }
      }
      this.forgetModelChoices();
      if (this.deps.clientRouteRuntime) await this.restoreCodexRouteSettings();
      else await this.restoreModelOptions();
      return;
    }
    const previous = this.modelIds;
    const providersChanged = !isDeepStrictEqual(this.modelProviders, providers);
    const changed = previous.join("\0") !== ids.join("\0");
    if (changed) {
      this.modelNotice.clear();
    }
    this.modelIds = ids;
    this.modelProviders = structuredClone(providers);
    if (providersChanged && this.deps.clientRouteRuntime && this.clientRoutes.vsCodeChat.mode === "classroom" && this.vsCodeOrigin) {
      try {
        const result = await this.deps.vsCodeRouteSettings?.publish({
          providers: this.modelProviders,
          adapter: this.clientRoutes.vsCodeChat.adapter as "responses" | "chat",
          origin: this.vsCodeOrigin,
        });
        if (result?.changed) {
          this.clientRoutes.vsCodeChat.health = "yellow";
          this.clientRoutes.vsCodeChat.restart = "restart-required";
          this.noteModelRestart("vscode");
        }
      } catch (error) {
        this.clientRoutes.vsCodeChat.health = "red";
        this.notice = error instanceof Error ? error.message : "VS Code Chat Client Route 設定失敗。";
      }
    }
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
    return this.serialConnectionOperation(() => this.copyKeyNow());
  }

  private async copyKeyNow(): Promise<void> {
    this.connectionError = undefined;
    try {
      const apiKey = this.connected ? (await this.deps.storage.getConnection())?.apiKey : undefined;
      if (!apiKey) {
        this.notice = this.connectionNotice = "無法複製 Classroom API Key。請重新連線後再試。";
        return;
      }
      await this.deps.clipboard.write(apiKey);
    } catch {
      this.notice = this.connectionNotice = "無法複製 Classroom API Key。請重新連線後再試。";
      return;
    }
    this.notice = this.connectionNotice = "已複製 Classroom API Key。請勿分享給不信任的人。";
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
    return this.serialConnectionOperation(() => this.clearConnectionNow());
  }

  private async clearConnectionNow(): Promise<void> {
    try {
      await this.deps.storage.clearConnection();
    } catch {
      this.notice = this.connectionNotice = "無法清除課堂連線。已保留原本連線，重新啟動後仍可能恢復。請稍後再試。";
      return;
    }
    this.applyConnectionIdentity(undefined);
    this.connectionError = undefined;
    this.connectionDraft = undefined;
    this.notice = undefined;
    this.catalog = undefined;
    this.catalogError = undefined;
    this.remoteCatalogHeld = false;
    this.mode = "native";
    if (this.deps.clientRouteRuntime) {
      this.clientRoutes.codex.mode = "native";
      this.clientRoutes.codex.restart = "ready";
      this.clientRoutes.claudeCode.mode = "native";
      this.clientRoutes.claudeCode.restart = "ready";
      this.clientRoutes.vsCodeChat.mode = "native";
      this.clientRoutes.vsCodeChat.restart = "ready";
      try { await this.saveClientRoutePreferences(); }
      catch {
        this.clientRoutes.codex.health = "red";
        this.clientRoutes.claudeCode.health = "red";
        this.clientRoutes.vsCodeChat.health = "red";
      }
    }
    this.modelIds = [];
    this.forgetModelChoices();
    let restoreFailed = false;
    try {
      if (this.deps.clientRouteRuntime) await this.restoreCodexRouteSettings();
      else await this.restoreModelOptions();
      if (this.deps.clientRouteRuntime && this.clientRoutes.codex.health !== "red") {
        this.clientRoutes.codex.health = this.detectedClients.codex ? "green" : "gray";
      }
    } catch {
      restoreFailed = true;
      if (this.deps.clientRouteRuntime) this.clientRoutes.codex.health = "red";
    }
    if (this.deps.clientRouteRuntime) {
      try {
        await this.deps.routes.setClaudeCodeRoute(false, this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl);
        if (this.clientRoutes.claudeCode.health !== "red") {
          this.clientRoutes.claudeCode.health = this.detectedClients.claude ? "green" : "gray";
        }
      } catch {
        restoreFailed = true;
        this.clientRoutes.claudeCode.health = "red";
      }
      try {
        await this.deps.vsCodeRouteSettings?.restore();
        if (this.clientRoutes.vsCodeChat.health !== "red") {
          this.clientRoutes.vsCodeChat.health = this.detectedClients.vsCodeChat ? "green" : "gray";
        }
      } catch {
        restoreFailed = true;
        this.clientRoutes.vsCodeChat.health = "red";
      }
    }
    if (restoreFailed) {
      this.notice = this.connectionNotice = "課堂連線已清除，但無法恢復客戶端的 Native 模型設定。請稍後重試或重新啟動。";
    }
  }

  async start(): Promise<void> {
    return this.serialConnectionOperation(() => this.startNow());
  }

  private async startNow(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      if (this.deps.adapterSettings) {
        try { this.adapters = await this.deps.adapterSettings.load(); }
        catch { this.adapterNotice = "無法讀取 adapter 設定，目前使用 Responses 預設值。"; }
      }
      if (this.deps.clientRouteSettings) {
        try {
          const settings = await this.deps.clientRouteSettings.load();
          this.clientRoutes = {
            codex: { ...this.clientRoutes.codex, ...settings.codex },
            claudeCode: { ...this.clientRoutes.claudeCode, ...settings.claudeCode },
            vsCodeChat: { ...this.clientRoutes.vsCodeChat, ...settings.vsCodeChat },
          };
          this.adapters = { ...this.adapters, codex: settings.codex.adapter as "responses" | "chat" };
          this.adapters = { ...this.adapters, claude: settings.claudeCode.adapter };
        } catch {
          this.clientRoutes = defaultClientRoutes();
        }
      }
      await this.restoreConnection();
      await this.detectClients();
      await this.startCodexRoute();
      await this.startClaudeCodeRoute();
      await this.startVsCodeRoute();
    })();
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
    const doc = this.deps.vsCodeRouteSettings ? { providers: [] } : await this.deps.copilot.read();
    const providers = Array.isArray(doc.providers) ? doc.providers : [];
    const already = this.deps.vsCodeRouteSettings || providers.some((provider) => provider?.name === "VCRouter");
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
    try {
      if (this.mode === "classroom") await this.publishModelOptions();
      else await this.restoreModelOptions();
    } catch {
      this.mode = "native";
      this.notice = "無法完成客戶端設定恢復。備份已保留，請重試切換個人模式。";
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

  private applyConnectionIdentity(connection: ClassroomConnection | undefined): void {
    this.connected = connection !== undefined;
    this.classLabel = connection && ([connection.session.class_name, connection.session.name].filter(Boolean).join(" · ") || undefined);
    this.courseTitle = connection?.session.class_name || undefined;
    this.sessionTitle = connection?.session.name || undefined;
    this.nickname = connection?.nickname;
    this.detail = connection ? "Classroom API Key 已設定。" : "";
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
    this.applyConnectionIdentity(connection);
    this.mode = "native";
    await this.loadCatalog();
    await this.loadModels(connection.apiKey);
    if (connection.mode === "classroom" && this.modelIds.length > 0) {
      this.mode = "classroom";
      this.clientModes = connection.clientModes ?? { codex: "classroom", claude: "classroom" };
    }
  }

  async stop(): Promise<void> {
    return this.serialConnectionOperation(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    this.proxyRunning = false;
    this.deps.proxy.stop();
    let failure: unknown;
    try {
      if (this.deps.clientRouteRuntime) await this.restoreCodexRouteSettings();
      else await this.restoreModelOptions();
      await this.deps.clientRouteRuntime?.stop("codex");
    } catch (error) {
      failure = error;
      if (this.deps.clientRouteRuntime) this.clientRoutes.codex.health = "red";
    }
    try {
      if (this.deps.clientRouteRuntime) {
        await this.deps.routes.setClaudeCodeRoute(false, this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl);
        await this.deps.clientRouteRuntime.stop("claudeCode");
      }
    } catch (error) {
      failure ??= error;
      this.clientRoutes.claudeCode.health = "red";
    }
    try {
      if (this.deps.clientRouteRuntime) {
        await this.deps.vsCodeRouteSettings?.restore();
        await this.deps.clientRouteRuntime.stop("vsCodeChat");
      }
    } catch (error) {
      failure ??= error;
      this.clientRoutes.vsCodeChat.health = "red";
    }
    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      throw new Error(this.redactSecrets(message || "無法停止 Client Route。"));
    }
  }

  private noteRestart(client: MustRestartClient): void {
    if (!this.mustRestart.includes(client)) {
      this.mustRestart.push(client);
    }
  }

  private noteModelRestart(client: MustRestartClient): void {
    if (!this.modelRestart.includes(client)) this.modelRestart.push(client);
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
  if (request.headers) next.headers = request.headers;
  if (request.signal) next.signal = request.signal;
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
