import { describe, expect, it } from "@effect/vitest";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";

import {
  isAllowedEndpointOrigin,
  isSupportedLinkProviderKind,
  linkProofScopes,
  parseManagedEndpointLocalOrigin,
} from "./linkChecks.ts";

describe("parseManagedEndpointLocalOrigin", () => {
  it.each([
    {
      input: "http://127.0.0.1:80",
      httpBaseUrl: "http://127.0.0.1",
      wsBaseUrl: "ws://127.0.0.1",
      port: 80,
    },
    {
      input: "https://127.0.0.1:443",
      httpBaseUrl: "https://127.0.0.1",
      wsBaseUrl: "wss://127.0.0.1",
      port: 443,
    },
  ])("accepts an explicit default port in $input", ({ input, httpBaseUrl, wsBaseUrl, port }) => {
    expect(parseManagedEndpointLocalOrigin(input)).toEqual({
      httpBaseUrl,
      wsBaseUrl,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: port },
    });
  });

  it.each([
    "ftp://127.0.0.1:3773",
    "http://user:password@127.0.0.1:3773",
    "http://127.0.0.1:3773/api",
    "http://127.0.0.1:3773?mode=test",
    "http://127.0.0.1:3773#fragment",
  ])("rejects non-origin URL %s", (input) => {
    expect(() => parseManagedEndpointLocalOrigin(input)).toThrow("Invalid local origin");
  });
});

// A link may only point at a loopback origin the caller actually reached this
// server on. The port the proof gets signed with is resolved separately, from
// the bound socket, so this check is purely about refusing a claim rather than
// correcting one.
describe("isAllowedEndpointOrigin", () => {
  it.each(["127.0.0.1", "localhost", "::1"])(
    "accepts loopback claim %s on the request port",
    (localHttpHost) => {
      expect(
        isAllowedEndpointOrigin({
          origin: { localHttpHost, localHttpPort: 3773 },
          requestUrl: "http://127.0.0.1:3773/api/t3-connect/link-proof",
        }),
      ).toBe(true);
    },
  );

  it("rejects a port the request did not arrive on", () => {
    expect(
      isAllowedEndpointOrigin({
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 9999 },
        requestUrl: "http://127.0.0.1:3773/api/t3-connect/link-proof",
      }),
    ).toBe(false);
  });

  it("rejects a non-loopback claimed origin", () => {
    expect(
      isAllowedEndpointOrigin({
        origin: { localHttpHost: "attacker.example.test", localHttpPort: 3773 },
        requestUrl: "http://127.0.0.1:3773/api/t3-connect/link-proof",
      }),
    ).toBe(false);
  });

  it("rejects a request that did not arrive over loopback", () => {
    expect(
      isAllowedEndpointOrigin({
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 443 },
        requestUrl: "https://environment.example.test/api/t3-connect/link-proof",
      }),
    ).toBe(false);
  });
});

describe("link proof provider kinds", () => {
  const proofRequest = (
    providerKind: RelayLinkProofRequest["endpoint"]["providerKind"],
  ): RelayLinkProofRequest => ({
    challenge: "challenge",
    relayIssuer: "https://relay.example.test",
    endpoint: {
      httpBaseUrl: "http://127.0.0.1:7331",
      wsBaseUrl: "ws://127.0.0.1:7331",
      providerKind,
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 7331 },
  });

  it("accepts managed and manual endpoints but not t3_relay", () => {
    expect(isSupportedLinkProviderKind(proofRequest("cloudflare_tunnel"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("manual"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("t3_relay"))).toBe(false);
  });

  it("only claims the managed-tunnel scope for tunnel links", () => {
    expect(linkProofScopes(proofRequest("cloudflare_tunnel"))).toEqual([
      "agent_activity_notifications",
      "managed_tunnels",
    ]);
    expect(linkProofScopes(proofRequest("manual"))).toEqual(["agent_activity_notifications"]);
  });
});
