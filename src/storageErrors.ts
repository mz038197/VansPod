export type StorageErrorCode = "legacy" | "unreadable" | "unavailable" | "clear-failed";

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode) {
    super(code === "legacy" ? "課堂連線需要安全遷移。" :
      code === "clear-failed" ? "無法清除已保存的課堂連線。" :
      code === "unreadable" ? "課堂連線無法解密。請重新連線。" : "安全儲存暫時無法使用。");
    this.name = "StorageError";
  }
}

