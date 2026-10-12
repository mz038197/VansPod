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
  startUi?(): Promise<{ origin: string }>;
  start(route: ClientRouteId): Promise<ClientRouteStart>;
  current?(route: ClientRouteId): ClientRouteStart | undefined;
  stop(route?: ClientRouteId): Promise<void>;
};

export function createClientRouteRuntime(options: {
  basePort: number;
  models?(route: ClientRouteId): readonly string[] | undefined;
  handle(
    accepted: AcceptedClientRoute,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void | Promise<void>;
}): ClientRouteRuntime {
  const listeners = new Map<ClientRouteId, http.Server>();
  let baseListener: { server: http.Server; origin: string; route: ClientRouteId | undefined; activate(route: ClientRouteId | undefined): void } | undefined;

  const routePort = (route: ClientRouteId): number => {
    if (options.basePort === 0) return 0;
    if (route === "claudeCode") return options.basePort + 1;
    if (route === "vsCodeChat") return options.basePort + 2;
    return options.basePort;
  };

  const open = async (initialRoute: ClientRouteId | undefined, port: number) => {
    let route = initialRoute;
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (route === "claudeCode" && request.method === "GET" && pathname === "/v1/models") {
        const ids = options.models?.(route) ?? [];
        const data = ids.map(id => ({
          id,
          display_name: id,
          type: "model",
          created_at: "2000-01-01T00:00:00Z",
        }));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({
          data,
          has_more: false,
          first_id: data[0]?.id ?? null,
          last_id: data.at(-1)?.id ?? null,
        }));
        return;
      }
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
    return {
      server,
      origin: `http://127.0.0.1:${address.port}`,
      get route() { return route; },
      activate(next: ClientRouteId | undefined) { route = next; },
    };
  };

  const startUi = async () => {
    if (baseListener) return { origin: baseListener.origin };
    try { baseListener = await open(undefined, routePort("codex")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      baseListener = await open(undefined, 0);
    }
    return { origin: baseListener.origin };
  };

  return {
    startUi,
    current(route) {
      const server = listeners.get(route);
      if (!server) return undefined;
      const address = server.address();
      if (!address || typeof address === "string") return undefined;
      return {
        route,
        health: "green",
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
      if (route === "codex") {
        const requestedOrigin = `http://127.0.0.1:${routePort(route)}`;
        const ui = await startUi();
        if (options.basePort !== 0 && ui.origin !== requestedOrigin) {
          try {
            const opened = await open(route, routePort(route));
            listeners.set(route, opened.server);
            return { route, health: "green", origin: opened.origin };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
            return { route, health: "red", origin: ui.origin };
          }
        }
        baseListener!.activate(route);
        listeners.set(route, baseListener!.server);
        return { route, health: "green", origin: ui.origin };
      }
      try {
        const opened = await open(route, routePort(route));
        listeners.set(route, opened.server);
        return { route, health: "green", origin: opened.origin };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        return { route, health: "red", origin: `http://127.0.0.1:${routePort(route)}` };
      }
    },
    async stop(route) {
      const selected = route ? [[route, listeners.get(route)] as const] : [...listeners.entries()];
      const closed = new Set<http.Server>();
      for (const [id, server] of selected) {
        if (!server) continue;
        if (id === "codex" && baseListener?.server === server && route) {
          baseListener.activate(undefined);
          listeners.delete(id);
          continue;
        }
        server.close();
        closed.add(server);
        listeners.delete(id);
      }
      if (!route && baseListener) {
        if (!closed.has(baseListener.server)) baseListener.server.close();
        baseListener = undefined;
      }
    },
  };
}
