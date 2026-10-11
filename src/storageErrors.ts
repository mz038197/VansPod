export type StorageErrorCode = "invalid" | "legacy" | "unreadable" | "unavailable" | "clear-failed" | "migration-failed" | "legacy-cleanup-failed";

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode) {
    super(code === "invalid" ? "課堂連線資料格式不正確。請重新連線。" :
      code === "legacy" ? "課堂連線需要安全遷移。" :
      code === "migration-failed" ? "舊課堂連線無法安全遷移，已移除舊憑證。請重新連線。" :
      code === "legacy-cleanup-failed" ? "無法移除舊課堂憑證。請手動刪除 VansPod 的 connection.json，再重新連線。" :
      code === "clear-failed" ? "無法清除已保存的課堂連線。" :
      code === "unreadable" ? "課堂連線無法解密。請重新連線。" : "安全儲存暫時無法使用。");
    this.name = "StorageError";
  }
}
