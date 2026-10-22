import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { it } from "node:test";
import { preferIpv4 } from "../networkPreference";

// A Router reachable on the given loopback addresses, all on one port, each answering with its own address.
async function withRouterOn(hosts: string[], run: (url: string) => Promise<void>): Promise<void> {
  const servers: http.Server[] = [];
  let port = 0;
  try {
    for (const host of hosts) {
      const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/plain"); res.end(host); });
      servers.push(server);
      server.listen(port, host); await once(server, "listening");
      port = (server.address() as { port: number }).port;
    }
    await run(`http://localhost:${port}/health`);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}

preferIpv4();

it("a Router reachable over both IPv4 and IPv6 is reached over IPv4", async () => {
  await withRouterOn(["127.0.0.1", "::1"], async url => {
    assert.equal(await (await fetch(url)).text(), "127.0.0.1");
  });
});

it("a Router reachable only over IPv6 is still reached", async () => {
  await withRouterOn(["::1"], async url => {
    assert.equal(await (await fetch(url)).text(), "::1");
  });
});
