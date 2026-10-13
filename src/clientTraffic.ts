export type TrafficClient = "codex" | "claude" | "vscode";

// The page asks once a second; a request shorter than that must still be seen.
const LINGER_MS = 1500;

export function createClientTraffic(now: () => number = Date.now) {
  const inFlight: Record<TrafficClient, number> = { codex: 0, claude: 0, vscode: 0 };
  const lastEndedAt: Record<TrafficClient, number> = { codex: -Infinity, claude: -Infinity, vscode: -Infinity };
  const isFlowing = (client: TrafficClient) => inFlight[client] > 0 || now() - lastEndedAt[client] < LINGER_MS;
  return {
    begin(client: TrafficClient): () => void {
      inFlight[client] += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        inFlight[client] -= 1;
        lastEndedAt[client] = now();
      };
    },
    flowing(): Record<TrafficClient, boolean> {
      return { codex: isFlowing("codex"), claude: isFlowing("claude"), vscode: isFlowing("vscode") };
    },
  };
}
