import type { VsCodeProvider } from "./vsCodeRouteSettings";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Router no longer accepts this Classroom API Key: the student has to redeem a new invite code. */
export class ClassroomKeyExpiredError extends Error {
  constructor() { super("Classroom API Key expired"); }
}

function isProviderRecord(value: unknown): value is VsCodeProvider {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const models = (value as VsCodeProvider).models;
  return Array.isArray(models) && models.every(model => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return false;
    const id = (model as Record<string, unknown>).id;
    return typeof id === "string" && id.trim().length > 0;
  });
}

export async function fetchSessionModelProviders(options: {
  root: string;
  apiKey: string;
  request?: FetchLike;
}): Promise<VsCodeProvider[]> {
  const request = options.request ?? fetch;
  const root = options.root.replace(/\/+$/, "");
  const response = await request(`${root}/extension/chat-language-models`, {
    signal: AbortSignal.timeout(5_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
  });
  if (response.status === 401) throw new ClassroomKeyExpiredError();
  if (!response.ok) throw new Error("session models failed");
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(isProviderRecord)) {
    throw new Error("session models failed");
  }
  return payload;
}
