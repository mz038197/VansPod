import http from "node:http";
import type { ClientRouteHealth, ClientRouteId } from "./clientRoutes";

export type AcceptedClientRoute = {
  /** Undefined is an emergency UI listener and must never accept model traffic. */
  route: ClientRouteId | undefined;
};

export type ClientRouteStart = {
  route: ClientRouteId;
  health: ClientRouteHealth;
  origin: string;
};

export type ClientRouteRuntime = {
  start(route: ClientRouteId): Promise<ClientRouteStart>;
  current?(route: ClientRouteId): ClientRouteStart | undefined;
  stop(route?: ClientRouteId): Promise<void>;
};

export function createClientRouteRuntime(options: {
  basePort: number;
  handle(
    accepted: AcceptedClientRoute,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void | Promise<void>;
}): ClientRouteRuntime {
  const listeners = new Map<ClientRouteId, http.Server>();
  let emergency: http.Server | undefined;

  const routePort = (route: ClientRouteId): number => {
    if (options.basePort === 0) return 0;
    if (route === "claudeCode") return options.basePort + 1;
    if (route === "vsCodeChat") return options.basePort + 2;
    return options.basePort;
  };

  const open = async (route: ClientRouteId | undefined, port: number) => {
    const server = http.createServer((request, response) => {
      void Promise.resolve(options.handle({ route }, request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Client Route listener has no loopback address");
    return { server, origin: `http://127.0.0.1:${address.port}` };
  };

  return {
    current(route) {
      const server = listeners.get(route);
      const selected = server ?? (route === "codex" ? emergency : undefined);
      if (!selected) return undefined;
      const address = selected.address();
      if (!address || typeof address === "string") return undefined;
      return {
        route,
        health: server ? "green" : "red",
        origin: `http://127.0.0.1:${address.port}`,
      };
    },
    async start(route) {
      const existing = listeners.get(route);
      if (existing) {
        const address = existing.address();
        if (!address || typeof address === "string") throw new Error("Client Route listener has no loopback address");
        return { route, health: "green", origin: `http://127.0.0.1:${address.port}` };
      }
      try {
        const opened = await open(route, routePort(route));
        listeners.set(route, opened.server);
        return { route, health: "green", origin: opened.origin };
      } catch (error) {
        if (route !== "codex" || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        if (emergency) {
          const address = emergency.address();
          if (address && typeof address !== "string") {
            return { route, health: "red", origin: `http://127.0.0.1:${address.port}` };
          }
        }
        const opened = await open(undefined, 0);
        emergency = opened.server;
        return { route, health: "red", origin: opened.origin };
      }
    },
    async stop(route) {
      const selected = route ? [[route, listeners.get(route)] as const] : [...listeners.entries()];
      for (const [id, server] of selected) {
        if (!server) continue;
        server.close();
        listeners.delete(id);
      }
      if ((!route || route === "codex") && emergency) {
        emergency.close();
        emergency = undefined;
      }
    },
  };
}
