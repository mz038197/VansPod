/** Headless runs retain real storage and HTTP behavior without controlling the desktop. */
export function readRuntimeOptions(environment: Record<string, string | undefined>) {
  const rawPort = environment.CLASSROOM_APP_PORT;
  const port = rawPort === undefined ? 47821 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || rawPort === "") {
    throw new Error("Classroom App 連接埠設定無效。");
  }
  const desktop = environment.CLASSROOM_APP_HEADLESS !== "1";
  return { port, desktop, restartClients: desktop };
}
