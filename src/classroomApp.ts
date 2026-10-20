import { isClassroomConnection, type ClassroomConnection, type ConnectionStorage } from "./secureStorage";
import { StorageError } from "./storageErrors";
import { defaultAdapters, isAdapterChoice, type AdapterSettings, type AdapterSettingsStorage } from "./adapterSettings";
import type { AdapterClient, AdapterId } from "./adapters";
import {
  defaultClientRoutes,
  type ClientRouteHealth,
  type ClientRouteRestartState,
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
import type { CodexRouteOptions, DetectedRouteClients } from "./routeFiles";
import { isCodexSearch } from "./modelProxy";

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

export const ENVIRONMENT_LABEL: Record<EnvironmentToolId, string> = {
  uv: "uv",
  git: "git",
  node: "Node.js",
  pwsh: "PowerShell 7",
};

/** Environment Tool Readiness：已就緒／需要修復（找得到但驗證不通過或逾時）／未安裝（找不到）。 */
export type EnvironmentReadiness = "ready" | "needsRepair" | "missing";

export type ToolReadiness = { readiness: EnvironmentReadiness; version?: string; reason?: string };

/**
 * 安裝程式的結果只用來產生提示；成敗一律以安裝後的 probe 為準。
 * exitAccepted：結束碼屬於可接受的值（例如 winget 0、3010、已安裝）；rebootRequired：安裝程式要求重新開機。
 */
export type EnvironmentInstallResult = CommandResult & { exitAccepted?: boolean; rebootRequired?: boolean };

/** 一次 Environment Install 的紀錄：安裝指令與輸出由 environment 自己寫入，驗證結果與總結由 ClassroomApp 補上。 */
export type EnvironmentInstallLog = {
  /** 本次的紀錄資料夾，結果畫面「開啟紀錄資料夾」開啟它。 */
  folder: string;
  verified(tool: EnvironmentToolId, readiness: ToolReadiness): Promise<void>;
  finish(summary: string): Promise<void>;
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
    run(cwd: string, command: string, onOutput?: (output: string) => void, signal?: AbortSignal): Promise<CommandResult>;
  };
  environment: {
    probe(tool: EnvironmentToolId): Promise<ToolReadiness>;
    install(
      tool: EnvironmentToolId,
      cwd: string,
      signal?: AbortSignal,
    ): Promise<EnvironmentInstallResult>;
    /** 開始一次安裝紀錄；沒有實作的平台（macOS）不留紀錄。 */
    startLog?(): Promise<EnvironmentInstallLog>;
    openLogFolder?(folder: string): Promise<void>;
  };
  // 測試注入的寫檔口。核心不呼叫它，MCP 動作只跑 catalog command。
  files: {
    write(path: string, contents: string): Promise<void>;
  };
  storage: ConnectionStorage;
  stopProcess(): void;
  proxyBaseUrl: string;
  routes: {
    migrateLegacyState(proxyBaseUrl: string, clients?: DetectedRouteClients): Promise<void>;
    setCodexRoute(options: CodexRouteOptions): Promise<void>;
    setClaudeCodeRoute(classroom: boolean, proxyBaseUrl: string, model?: string): Promise<void>;
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
  /** `ok` is false when the upstream did not answer the request successfully. */
  send(upstream: UpstreamSend): Promise<{ ok: boolean }>;
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
  readiness: EnvironmentReadiness;
  version?: string;
  reason?: string;
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
  allowlistError?: string;
  pendingCommand?: string;
  commandOutput?: string;
  commandRunning: boolean;
  commandSucceeded?: boolean;
  commandAborted?: boolean;
  installedActionIds?: string[];
  copiedSnippetIds?: string[];
  mode: ModelSwitchMode;
  clientModes?: ClientModes;
  clientRoutes?: ClientRoutes;
  detectedClients?: Record<AdapterClient, boolean>;
  allowedModels?: string[];
  modelId?: string;
  tools: EnvironmentToolView[];
  environmentNotice?: string;
  /** 最近一次 Environment Install 的紀錄資料夾；有值時結果畫面提供「開啟紀錄資料夾」。 */
  environmentLogFolder?: string;
  mustRestart?: MustRestartClient[];
  modelRestart?: MustRestartClient[];
  connectionError?: string;
  connectionNotice?: string;
  connectionDraft?: { inviteCode: string; nickname: string };
};

const LOCAL_LIST_NOTE = "這是本機清單。";
export const COPIED_KEY_NOTICE = "已複製 Classroom API Key。請勿分享給不信任的人。";
const INSTALL_UNAVAILABLE = "尚未指定專案資料夾，安裝不可用。";
const ENVIRONMENT_ABORTED = "已中止安裝。系統安裝程式可能仍在執行，請等待結束或稍後重新安裝。";
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
  private readonly copiedSnippets = new Map<string, string>();
  private commandOutput: string | undefined;
  private commandRunning = false;
  private commandAborted: boolean | undefined;
  private runningInstall: { abort: AbortController; settled: Promise<void>; settle(): void } | undefined;
  private stopping = false;
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
  private environmentReadiness: Record<EnvironmentToolId, ToolReadiness> = {
    uv: { readiness: "missing" },
    git: { readiness: "missing" },
    node: { readiness: "missing" },
    pwsh: { readiness: "missing" },
  };
  private environmentSelected = new Set<EnvironmentToolId>();
  private environmentNotice: string | undefined;
  private environmentLog: EnvironmentInstallLog | undefined;
  private proxyRunning = false;
  private mustRestart: MustRestartClient[] = [];
  private modelRestart: MustRestartClient[] = [];
  private allowlistError: string | undefined;
  private routeRestartNoted = false;
  private vsCodeOrigin: string | undefined;
  private sending = new Map<ProxyClient, string>();

  constructor(private readonly deps: ClassroomAppDeps) {}

  private serialConnectionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.connectionOperations.then(operation, operation);
    this.connectionOperations = next.catch(() => {});
    return next;
  }

  // 整頁畫面用這個：複製成功的提示只出現一次，重新整理就不會再讓法鬥說一遍。
  pageView(): ClassroomAppView {
    const view = this.view();
    if (this.notice === COPIED_KEY_NOTICE) this.notice = this.connectionNotice = undefined;
    return view;
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
      view.copiedSnippetIds = (this.catalog.snippets ?? [])
        .filter((snippet) => this.copiedSnippets.get(snippet.id) === snippet.body)
        .map((snippet) => snippet.id);
    }
    if (this.catalogError) {
      view.catalogError = this.catalogError;
    }
    if (this.allowlistError) view.allowlistError = this.allowlistError;
    if (this.pendingCommand) {
      view.pendingCommand = this.pendingCommand;
    }
    if (this.commandOutput !== undefined) {
      view.commandOutput = this.commandOutput;
    }
    if (this.commandSucceeded !== undefined) view.commandSucceeded = this.commandSucceeded;
    if (this.commandAborted) view.commandAborted = true;
    if (this.mode === "classroom" && this.modelIds[0]) {
      view.modelId = this.modelIds[0];
    }
    if (this.environmentLog) {
      view.environmentLogFolder = this.environmentLog.folder;
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
      await this.probeEnvironmentTool(tool);
    }
  }

  private async probeEnvironmentTool(tool: EnvironmentToolId): Promise<ToolReadiness> {
    let readiness: ToolReadiness;
    try {
      readiness = await this.deps.environment.probe(tool);
    } catch {
      readiness = { readiness: "missing" };
    }
    this.environmentReadiness[tool] = readiness;
    return readiness;
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
    if (this.stopping || this.commandRunning || !this.projectFolder) {
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
    const abort = this.beginInstall();
    const rebootSuggested: EnvironmentToolId[] = [];
    let failure: string | undefined;
    try {
      await this.startEnvironmentLog();
      for (const tool of selected) {
        if (abort.signal.aborted) {
          break;
        }
        let result: EnvironmentInstallResult | undefined;
        try {
          result = await this.deps.environment.install(tool, cwd, abort.signal);
        } catch {
          result = undefined;
        }
        if (abort.signal.aborted) {
          break;
        }
        // 安裝程式的結束碼只產生提示；裝好與否以立刻重新驗證為準。
        // 驗證會讀登錄檔裡最新的 PATH，剛裝好的工具不必重開 VansPod 就看得到。
        const verified = await this.probeEnvironmentTool(tool);
        await this.environmentLog?.verified(tool, verified).catch(() => {});
        if (verified.readiness === "ready") {
          if (result?.rebootRequired) rebootSuggested.push(tool);
          continue;
        }
        failure = environmentInstallFailure(ENVIRONMENT_LABEL[tool], result, verified);
        break;
      }
    } finally {
      this.endInstall();
      this.commandRunning = false;
    }
    if (abort.signal.aborted) {
      await this.checkEnvironment();
      this.environmentNotice = ENVIRONMENT_ABORTED;
      await this.environmentLog?.finish("已中止").catch(() => {});
      return;
    }
    const notices = [];
    if (rebootSuggested.length > 0) {
      notices.push(`${rebootSuggested.map((tool) => ENVIRONMENT_LABEL[tool]).join("、")} 已就緒，建議重新開機。`);
    }
    if (failure) notices.push(failure);
    this.environmentNotice = notices.length > 0 ? notices.join("") : undefined;
    await this.environmentLog?.finish(this.environmentNotice ?? "完成").catch(() => {});
  }

  /** 每次 Environment Install 開一份新紀錄；紀錄開不了也照常安裝。 */
  private async startEnvironmentLog(): Promise<void> {
    try {
      this.environmentLog = await this.deps.environment.startLog?.();
    } catch {
      this.environmentLog = undefined;
    }
  }

  /** 結果畫面「開啟紀錄資料夾」：開啟最近一次安裝的紀錄資料夾。 */
  async openEnvironmentLog(): Promise<void> {
    if (!this.environmentLog) {
      return;
    }
    await this.deps.environment.openLogFolder?.(this.environmentLog.folder);
  }

  private environmentTools(): EnvironmentToolView[] {
    return ENVIRONMENT_TOOLS.map((id) => ({
      id,
      label: ENVIRONMENT_LABEL[id],
      ...this.environmentReadiness[id],
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
    const outcome = await this.deps.send(withHttp(upstream, request));
    // Only a successful request proves the client loaded the new settings and the route works.
    if (!outcome.ok) return forwardedRecord(upstream);
    if (this.deps.clientRouteRuntime && request.client !== "copilot" && this.clientModes[request.client] === "classroom") {
      const route = request.client === "codex" ? this.clientRoutes.codex : this.clientRoutes.claudeCode;
      route.health = "green";
      route.restart = "ready";
      this.modelRestart = this.modelRestart.filter(client => client !== request.client);
    }
    if (this.deps.clientRouteRuntime && request.client === "copilot" && this.clientRoutes.vsCodeChat.mode === "classroom") {
      this.clientRoutes.vsCodeChat.health = "green";
      this.clientRoutes.vsCodeChat.restart = "ready";
      this.modelRestart = this.modelRestart.filter(client => client !== "vscode");
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
      this.assertAllowedModel(request.model);
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
      // Web Search is a switch on the Class Session that Router enforces, not a model on the allowlist.
      if (!isCodexSearch(request.client, request.path)) this.assertAllowedModel(request.model);
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

  private assertAllowedModel(requested: string | undefined): void {
    if (this.modelIds.length === 0) return;
    const id = requested?.startsWith("VCRouter/")
      ? requested.slice("VCRouter/".length)
      : requested;
    if (!id || !this.modelIds.includes(id)) {
      throw new Error(`模型 ${id || "(missing)"} 不在課堂允許清單。`);
    }
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
      return id;
    }
    return this.sending.get(client) ?? first;
  }

  private visibleNotice(): string | undefined {
    const parts: string[] = [];
    if (this.notice) {
      parts.push(this.notice);
    }
    if (this.allowlistError) parts.push(this.allowlistError);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  private forgetModelChoices(): void {
    this.sending.clear();
  }

  private async publishModelOptions(updateClient?: AdapterClient): Promise<void> {
    const first = this.modelIds[0];
    if (!first || this.mode !== "classroom") {
      await this.restoreModelOptions();
      return;
    }
    const options = this.codexClassroomOptions(first);
    if (updateClient !== "claude") {
      const mode = this.deps.clientRouteRuntime ? this.clientRoutes.codex.mode : this.clientModes.codex;
      await this.codexLifecycle().write(mode, options);
    }
  }

  private codexClassroomOptions(first = this.modelIds[0]): Extract<CodexRouteOptions, { mode: "classroom" }> {
    return {
      mode: "classroom",
      ids: [...this.modelIds],
      selectedModel: this.sending.get("codex") ?? first!,
      proxyBaseUrl: this.clientRouteOrigins.codex ?? this.deps.proxyBaseUrl,
      restart: true,
    };
  }

  private async restoreModelOptions(): Promise<void> {
    await this.deps.routes.setCodexRoute({ mode: "native", proxyBaseUrl: this.deps.proxyBaseUrl });
  }

  private codexLifecycle() {
    const route = this.clientRoutes.codex;
    const origin = this.clientRouteOrigins.codex ?? this.deps.proxyBaseUrl;
    return {
      route,
      write: (mode: ModelSwitchMode, classroom?: Extract<CodexRouteOptions, { mode: "classroom" }>) =>
        this.deps.routes.setCodexRoute(mode === "classroom" ? classroom ?? this.codexClassroomOptions() : { mode: "native", proxyBaseUrl: origin }),
      setMode: (mode: ModelSwitchMode) => {
        route.mode = mode;
        this.clientModes.codex = mode;
      },
      setState: (mode: ModelSwitchMode, health: ClientRouteHealth, restart: ClientRouteRestartState = "ready") => {
        route.mode = mode;
        route.health = health;
        route.restart = restart;
        this.clientModes.codex = mode;
      },
      stop: async () => {
        await this.deps.routes.setCodexRoute({ mode: "native", proxyBaseUrl: origin });
        await this.deps.clientRouteRuntime?.stop("codex");
      },
    };
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
    this.commandAborted = undefined;
    this.commandSucceeded = undefined;
  }

  async confirm(): Promise<void> {
    if (this.stopping || this.commandRunning || !this.projectFolder || !this.pendingCommand) {
      return;
    }
    const cwd = this.projectFolder;
    const command = this.pendingCommand;
    const actionId = this.pendingActionId;
    this.commandRunning = true;
    this.commandOutput = undefined;
    this.commandSucceeded = undefined;
    this.commandAborted = undefined;
    const abort = this.beginInstall();
    try {
      const result = await this.deps.commands.run(cwd, command, (output) => {
        this.commandOutput = output;
      }, abort.signal);
      this.commandOutput = result.output;
      if (result.aborted) this.commandAborted = true;
      this.commandSucceeded = !result.aborted && result.exitCode === 0;
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
      this.endInstall();
      this.commandRunning = false;
    }
  }

  private beginInstall(): AbortController {
    const abort = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.runningInstall = { abort, settled, settle };
    return abort;
  }

  private endInstall(): void {
    this.runningInstall?.settle();
    this.runningInstall = undefined;
  }

  /** Abort Install：學生確認後終止執行中的安裝；沒有安裝時不做事。 */
  async abortInstall(): Promise<void> {
    const install = this.runningInstall;
    install?.abort.abort();
    await install?.settled;
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
    const connection = { version: 1 as const, apiKey: redeemed?.api_key, session: redeemed?.session, nickname: name };
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
    this.allowlistError = undefined;
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
        this.settleVsCodePublish(result?.changed);
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
    const lifecycle = this.codexLifecycle();
    const route = lifecycle.route;
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
    lifecycle.setMode(mode);
    try {
      // Preference persistence and the route-file journal both precede the client write.
      await this.saveClientRoutePreferences();
      const aggregate = Object.values(this.clientModes).includes("classroom") ? "classroom" : "native";
      if (!await this.saveMode(aggregate, this.clientModes)) throw new Error("mode persistence failed");
      await lifecycle.write(mode);
      lifecycle.setState(mode, mode === "classroom" ? "yellow" : "green", mode === "classroom" ? "restart-required" : "ready");
      route.adapter = this.adapters.codex;
      this.notice = undefined;
      this.adapterNotice = undefined;
    } catch {
      this.clientRoutes.codex = previousRoute;
      this.clientModes = previousModes;
      try { await this.saveClientRoutePreferences(); } catch { /* Keep the rollback visible in memory. */ }
      try { await this.codexLifecycle().write(previousRoute.mode); } catch { /* The route remains in its previous mode. */ }
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
      if (mode === "classroom") this.settleVsCodePublish(result?.changed);
      else {
        route.health = "green";
        route.restart = "ready";
        if (result?.changed) this.noteModelRestart("vscode");
      }
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
      await this.deps.routes.setClaudeCodeRoute(mode === "classroom", this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl, this.modelIds[0]);
      route.health = mode === "classroom" ? "yellow" : "green";
      route.restart = mode === "classroom" ? "restart-required" : "ready";
      this.notice = undefined;
      this.adapterNotice = undefined;
    } catch {
      this.clientRoutes.claudeCode = previousRoute;
      this.clientModes = previousModes;
      try { await this.saveClientRoutePreferences(); } catch { /* Keep the rollback visible in memory. */ }
      try {
        await this.deps.routes.setClaudeCodeRoute(previousRoute.mode === "classroom", this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl, this.modelIds[0]);
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
      if (connection && !this.deps.clientRouteSettings) {
        await this.deps.storage.setConnection({ ...connection, mode, clientModes }, { allowTemporary: false });
      }
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
    await this.deps.routes.migrateLegacyState(this.deps.proxyBaseUrl, this.detectedClients);
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
    let lifecycle = this.codexLifecycle();
    if (!this.detectedClients.codex) {
      lifecycle.setState("native", "gray");
      return;
    }
    const alreadyRunning = runtime.current?.("codex")?.health === "green";
    const restartPending = this.clientRoutes.codex.health === "yellow" &&
      this.clientRoutes.codex.restart === "restart-required";
    const retryingNativeRecovery = this.clientRoutes.codex.health === "red" && this.clientRoutes.codex.mode === "native";
    let health: "green" | "red" = "red";
    try {
      const started = await runtime.start("codex");
      this.clientRouteOrigins.codex = started.origin;
      health = started.health === "green" ? "green" : "red";
    }
    catch { health = "red"; }
    if (health === "red") {
      lifecycle.setState("native", "red");
      try { await this.saveClientRoutePreferences(); } catch { /* The visible red state remains authoritative. */ }
      try { await lifecycle.write("native"); } catch { /* Retried on reload. */ }
      return;
    }
    lifecycle = this.codexLifecycle(); // start() supplied the route's authoritative origin.
    if (this.clientRoutes.codex.mode === "classroom" && (!this.connected || this.modelIds.length === 0)) {
      lifecycle.setMode("native");
      try { await this.saveClientRoutePreferences(); } catch { /* Native remains the safe runtime state. */ }
    }
    if (retryingNativeRecovery) {
      try { await lifecycle.write("native"); }
      catch {
        lifecycle.setState("native", "red");
        return;
      }
    }
    this.clientModes.codex = this.clientRoutes.codex.mode === "classroom" && this.connected && this.modelIds.length > 0
      ? "classroom"
      : "native";
    if (alreadyRunning && restartPending && this.clientModes.codex === "classroom") return;
    // Listener recovery never restores Classroom automatically after a red failure.
    lifecycle.setState(this.clientModes.codex, "green");
    if (!alreadyRunning && this.clientModes.codex === "classroom") {
      try {
        await lifecycle.write("classroom");
        lifecycle.setState("classroom", "yellow", "restart-required");
      } catch {
        lifecycle.setState("native", "red");
        try { await this.saveClientRoutePreferences(); } catch { /* Visible red state wins. */ }
      }
    }
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
        this.settleVsCodePublish(result?.changed);
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
    const restartPending = route.health === "yellow" && route.restart === "restart-required";
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
    this.clientModes.claude = route.mode === "classroom" && this.connected && this.modelIds.length > 0
      ? "classroom"
      : "native";
    if (alreadyRunning && restartPending && this.clientModes.claude === "classroom") return;
    route.health = "green";
    route.restart = "ready";
    if (alreadyRunning) return;
    try {
      await this.deps.routes.setClaudeCodeRoute(
        this.clientModes.claude === "classroom",
        this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl,
        this.modelIds[0],
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
    const refreshed = await this.loadModels(apiKey);
    this.allowlistError = refreshed
      ? undefined
      : "重新載入課堂模型失敗，已保留上次成功的模型清單。";
    const current = this.mode === "classroom" ? this.modelIds.join("\0") : "";
    if (previous !== current) {
      this.modelRestart = (["codex", "claude"] as const).filter(client => this.clientModes[client] === "classroom");
      if (this.deps.clientRouteRuntime) {
        if (this.clientRoutes.codex.mode === "classroom") {
          this.clientRoutes.codex.health = "yellow";
          this.clientRoutes.codex.restart = "restart-required";
        }
        if (this.clientRoutes.claudeCode.mode === "classroom") {
          this.clientRoutes.claudeCode.health = "yellow";
          this.clientRoutes.claudeCode.restart = "restart-required";
        }
      }
    }
  }

  private async loadModels(apiKey: string): Promise<boolean> {
    let payload: string[] | VsCodeProvider[];
    try {
      payload = await this.deps.router.fetchSessionModels(apiKey);
    } catch {
      return false;
    }
    if (!Array.isArray(payload)) return false;
    const items: unknown[] = payload;
    const stringPayload = items.every(item => typeof item === "string");
    const providerPayload = items.every(
      item => !!item && typeof item === "object" && !Array.isArray(item),
    );
    if (!stringPayload && !providerPayload) return false;
    const providers = stringPayload ? [] : items as VsCodeProvider[];
    const ids: string[] = [];
    if (stringPayload) {
      ids.push(...items as string[]);
    } else {
      for (const provider of providers) {
        if (!Array.isArray(provider.models)) return false;
        for (const model of provider.models) {
          const id = model && typeof model === "object" && !Array.isArray(model)
            ? (model as Record<string, unknown>).id
            : undefined;
          if (typeof id !== "string" || !id.trim()) return false;
          ids.push(id);
        }
      }
    }
    if (ids.length === 0 || ids.some(id => !id.trim())) {
      this.modelIds = [];
      this.modelProviders = [];
      this.mode = "native";
      if (this.deps.clientRouteRuntime) {
        this.codexLifecycle().setMode("native");
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
      if (this.deps.clientRouteRuntime) {
        try {
          await this.codexLifecycle().write("native");
          if (this.clientRoutes.codex.health !== "red") {
            this.clientRoutes.codex.health = this.detectedClients.codex ? "green" : "gray";
          }
        } catch {
          this.clientRoutes.codex.health = "red";
        }
      } else {
        await this.restoreModelOptions();
      }
      return true;
    }
    const previous = this.modelIds;
    const providersChanged = !isDeepStrictEqual(this.modelProviders, providers);
    const changed = previous.join("\0") !== ids.join("\0");
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
      return true;
    }
    for (const client of PROXY_CLIENTS) {
      const current = this.sending.get(client);
      if (!current || ids.includes(current)) {
        continue;
      }
      this.sending.delete(client);
    }
    await this.publishModelOptions();
    if (this.clientModes.claude === "classroom" && previous[0] !== ids[0]) {
      try {
        await this.deps.routes.setClaudeCodeRoute(true, this.clientRouteOrigins.claudeCode ?? this.deps.proxyBaseUrl, ids[0]);
      } catch {
        this.notice = "無法更新 Claude Code 的課堂模型選項。";
      }
    }
    return true;
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
    this.notice = this.connectionNotice = COPIED_KEY_NOTICE;
  }

  async copySnippet(snippetId: string): Promise<boolean> {
    const snippet = this.catalog?.snippets?.find((item) => item.id === snippetId);
    if (!snippet) return false;
    try {
      await this.deps.clipboard.write(snippet.body);
      this.copiedSnippets.set(snippet.id, snippet.body);
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
    this.allowlistError = undefined;
    this.catalog = undefined;
    this.catalogError = undefined;
    this.remoteCatalogHeld = false;
    this.mode = "native";
    if (this.deps.clientRouteRuntime) {
      this.codexLifecycle().setMode("native");
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
      if (this.deps.clientRouteRuntime) await this.codexLifecycle().write("native");
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
    this.stopping = false;
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
      await this.detectClients();
      await this.deps.routes.migrateLegacyState(this.deps.proxyBaseUrl, this.detectedClients);
      await this.restoreConnection();
      await this.startCodexRoute();
      await this.startClaudeCodeRoute();
      await this.startVsCodeRoute();
    })();
    await this.initialization;
    this.deps.proxy.start();
    this.proxyRunning = true;
    if (!this.routeRestartNoted) {
      this.noteRestart("codex");
      this.noteRestart("claude");
      this.routeRestartNoted = true;
    }
    // Embedders created before the route runtime existed still receive the Codex
    // projection. The shipped app always supplies the independent runtime.
    if (!this.deps.clientRouteRuntime) {
      try {
        if (this.mode === "classroom") await this.publishModelOptions();
        else await this.restoreModelOptions();
      } catch {
        this.mode = "native";
        this.notice = "無法完成客戶端設定恢復。備份已保留，請重試切換個人模式。";
      }
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
    if (this.commandRunning) throw new Error("安裝中，請完成後再結束。");
    this.stopping = true;
    try { await this.serialConnectionOperation(() => this.stopNow()); }
    catch (error) { this.stopping = false; throw error; }
  }

  private async stopNow(): Promise<void> {
    this.proxyRunning = false;
    this.deps.proxy.stop();
    let failure: unknown;
    try {
      if (this.deps.clientRouteRuntime) await this.codexLifecycle().stop();
      else await this.restoreModelOptions();
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

  // An unchanged republish cannot clear a restart VS Code still owes; only its first request can.
  private settleVsCodePublish(changed: boolean | undefined): void {
    if (changed) this.noteModelRestart("vscode");
    const waiting = this.modelRestart.includes("vscode");
    this.clientRoutes.vsCodeChat.health = waiting ? "yellow" : "green";
    this.clientRoutes.vsCodeChat.restart = waiting ? "restart-required" : "ready";
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

/** 安裝後驗證未通過時的提示；安裝程式要求重新開機時，請學生重開機後再檢查。 */
function environmentInstallFailure(
  label: string,
  result: EnvironmentInstallResult | undefined,
  verified: ToolReadiness,
): string {
  const rejected = result?.exitAccepted === false && result.exitCode !== undefined
    ? `安裝失敗（結束碼 ${result.exitCode}），`
    : "";
  const state = verified.readiness === "missing" ? "安裝後仍偵測不到" : "安裝後仍需要修復";
  const reason = verified.reason ? `：${verified.reason}` : "";
  const next = result?.rebootRequired ? "請重新開機後按「重新檢查」。" : "請稍後按「重新檢查」。";
  return `${label} ${rejected}${state}${reason}。${next}`;
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
