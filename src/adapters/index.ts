import { ResponsesAdapter } from "./responses";
import { ChatAdapter } from "./chat";
import { MessagesAdapter } from "./messages";
import { AdapterError, type AdapterId, type ModelApiAdapter } from "./types";
export type { AdapterId, AdapterClient, ModelApiAdapter, AdapterRequest } from "./types";

const responses = new ResponsesAdapter();
const chat = new ChatAdapter();
const messages = new MessagesAdapter();
export function modelApiAdapter(id: AdapterId): ModelApiAdapter {
  if (id === "responses") return responses;
  if (id === "chat") return chat;
  if (id === "messages") return messages;
  throw new AdapterError("無效的 model API adapter。");
}
