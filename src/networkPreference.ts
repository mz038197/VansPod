import dns from "node:dns";

/**
 * Some networks (an iPhone hotspot on a mobile carrier) connect to Router over IPv6 and then never
 * answer, so a request hangs until it times out. IPv4 goes first; IPv6 is only the fallback.
 */
export function preferIpv4(): void {
  dns.setDefaultResultOrder("ipv4first");
}
