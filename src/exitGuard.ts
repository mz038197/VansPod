/** 結束或移除時，正在進行而會被中斷的工作。 */
export type ExitWork = { installing: boolean; activeRequests: number };

export type ExitDecision = { proceed: true } | { proceed: false; message: string };

/** 安裝與模型回答合併成一次確認；未確認不中斷任何工作。 */
export function exitDecision(action: "stop" | "uninstall", work: ExitWork, confirmed: boolean): ExitDecision {
  const running = [
    ...(work.installing ? ["安裝仍在執行"] : []),
    ...(work.activeRequests ? ["仍有模型回答"] : []),
  ];
  if (!running.length || confirmed) return { proceed: true };
  return { proceed: false, message: `${running.join("、")}，確認中止並${action === "stop" ? "結束" : "移除"} VansPod？` };
}

export function removalInterruptions(work: ExitWork): string {
  return `${work.installing ? "\n安裝仍在執行，移除前將中止安裝。" : ""}${work.activeRequests ? "\n仍有模型回答，移除將中斷目前回答。" : ""}`;
}
