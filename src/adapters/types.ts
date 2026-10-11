export type AdapterId = "chat" | "responses" | "messages";
export type AdapterClient = "codex" | "claude";
export type JsonObject = Record<string, unknown>;

export interface AdapterRequest {
  client: AdapterClient;
  model: string;
  body: JsonObject;
  routerBaseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

export interface ModelApiAdapter {
  readonly id: AdapterId;
  send(request: AdapterRequest): Promise<Response>;
}

export class AdapterError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterError(`${context} 必須是物件。`);
  return value as JsonObject;
}

export function list(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new AdapterError(`${context} 必須是陣列。`);
  return value;
}

export function string(value: unknown, context: string): string {
  if (typeof value !== "string") throw new AdapterError(`${context} 必須是文字。`);
  return value;
}

export function allowedFields(value: JsonObject, fields: readonly string[], context: string): void {
  const unsupported = Object.keys(value).find(key => value[key] !== undefined && !fields.includes(key));
  if (unsupported) throw new AdapterError(`${context} 無法轉換欄位 ${unsupported}。`);
}
