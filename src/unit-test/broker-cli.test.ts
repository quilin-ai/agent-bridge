import { describe, test, expect } from "bun:test";
import { resolveBindHost } from "../cli/broker";

describe("resolveBindHost — §7.3 bind-host guard (loopback whitelist)", () => {
  test("empty string normalises to loopback, no warning (no silent all-interfaces bind)", () => {
    expect(resolveBindHost("")).toEqual({ host: "127.0.0.1", warning: null });
  });

  test("loopback hosts pass without warning", () => {
    for (const h of ["127.0.0.1", "::1", "localhost"]) {
      const r = resolveBindHost(h);
      expect(r.host).toBe(h);
      expect(r.warning).toBeNull();
    }
  });

  test("Tailscale CGNAT 100.64.0.0/10 passes without warning", () => {
    for (const h of ["100.64.0.1", "100.100.100.100", "100.127.255.254"]) {
      expect(resolveBindHost(h).warning).toBeNull();
    }
  });

  test("public 100.x OUTSIDE the CGNAT range still warns (not real Tailscale)", () => {
    for (const h of ["100.0.0.1", "100.63.0.1", "100.128.0.1", "100.200.0.1"]) {
      expect(resolveBindHost(h).warning).toBeTruthy();
    }
  });

  test("exposed addresses warn (0.0.0.0, ::, LAN IPs — the blacklist gap)", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "10.0.0.2"]) {
      const r = resolveBindHost(h);
      expect(r.host).toBe(h);
      expect(r.warning).toBeTruthy();
    }
  });
});
