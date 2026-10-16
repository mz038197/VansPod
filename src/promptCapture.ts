// Prompt Capture 記錄器：只存在記憶體，每次啟動錄製都是關閉（ADR-0009）。

export type CaptureView = {
  id: number; time: string; client: string; model: string;
  protocol: "messages" | "responses" | "chat"; adapter: string;
  failedStatus?: number; webSearchFollowUp: boolean; newConversation: boolean;
  system: string[];
  tools: { name: string; description: string; schema: unknown }[];
  messages: { role: "user" | "assistant" | "tool"; kind: "text" | "tool_use" | "tool_result";
              name?: string; text: string; isNew: boolean; reminder: boolean }[];
  sizes: { system: number; tools: number; reminder: number; history: number; fresh: number };
  total: number; sent: unknown; raw: unknown; path: string;
};

export type CaptureList = { captures: CaptureView[]; dropped: number };

export type PromptCapture = {
  readonly recording: boolean;
  start(): void;
  pause(): void;
  clear(): void;
  list(): CaptureList;
};

export function createPromptCapture(): PromptCapture {
  let recording = false;
  let captures: CaptureView[] = [];
  let dropped = 0;
  return {
    get recording() { return recording; },
    start() { recording = true; },
    pause() { recording = false; },
    clear() { captures = []; dropped = 0; },
    list() { return { captures: [...captures], dropped }; },
  };
}
