import { EnvironmentId } from "@t3tools/contracts";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpServer, type HttpServerRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const encode = (value: string) => new TextEncoder().encode(value);

/** A linked environment whose secret store can refuse writes, and the relay calls it made. */
const withService = <A, E>(
  options: {
    readonly failHoldWrite?: boolean;
    readonly failActivityWrite?: boolean;
    readonly relayFails?: boolean;
    readonly failActivityRead?: boolean;
    readonly failHoldRead?: boolean;
    /** The first relay call reports itself, then waits for this before answering. */
    readonly holdFirstRelayCall?: {
      readonly started: () => void;
      readonly released: Promise<void>;
    };
  },
  body: (input: {
    readonly preferences: { readonly update: CloudLink.CloudLink["Service"]["updatePreferences"] };
    readonly stored: Map<string, Uint8Array>;
    readonly relayCalls: Array<boolean>;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential")],
      [HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, encode("false")],
      [PUBLISH_AGENT_ACTIVITY_SECRET, encode("false")],
    ]);
    const relayCalls: Array<boolean> = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { holdWebhooksWhileOffline: boolean };
        relayCalls.push(payload.holdWebhooksWhileOffline);
        if (relayCalls.length === 1 && options.holdFirstRelayCall) {
          options.holdFirstRelayCall.started();
          return options.holdFirstRelayCall.released.then(() => Response.json(payload));
        }
        return options.relayFails
          ? Promise.resolve(new Response("unavailable", { status: 503 }))
          : Promise.resolve(Response.json(payload));
      },
      { preconnect: () => {} },
    );
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          (options.failActivityRead && name === PUBLISH_AGENT_ACTIVITY_SECRET) ||
          (options.failHoldRead && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)
            ? Effect.fail(
                new ServerSecretStore.SecretStoreReadError({
                  resource: name,
                  cause: new Error("busy"),
                }),
              )
            : Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) =>
          (options.failHoldWrite && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET) ||
          (options.failActivityWrite && name === PUBLISH_AGENT_ACTIVITY_SECRET)
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: new Error("read-only"),
                }),
              )
            : Effect.sync(() => void stored.set(name, value)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ requestCatchUp: () => Effect.void }),
      // Saving preferences touches none of the link's other dependencies.
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
      NodeServices.layer,
    );
    return yield* Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      return yield* body({ preferences: { update: link.updatePreferences }, stored, relayCalls });
    }).pipe(
      Effect.provide(CloudLink.layer.pipe(Layer.provide(layerDependencies))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

it.effect("tells the relay before saving the hold setting locally", () =>
  withService({}, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      yield* preferences.update({ publishAgentActivity: true, holdWebhooksWhileOffline: true });
      assert.deepEqual(relayCalls, [true]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  ),
);

it.effect("puts the relay back when the local save fails", () =>
  withService({ failHoldWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "CloudLinkInternalError",
        operation: "persist-preferences",
      });
      assert.deepEqual(relayCalls, [true, false]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("leaves the relay untouched when the activity setting can't be saved", () =>
  withService({ failActivityWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "CloudLinkInternalError",
        operation: "persist-preferences",
      });
      assert.deepEqual(relayCalls, []);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("keeps both settings unchanged when the relay refuses the hold change", () =>
  withService({ relayFails: true }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("changes nothing when the current activity setting can't be read", () =>
  withService({ failActivityRead: true, relayFails: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "CloudLinkInternalError", operation: "read-preferences" });
      assert.deepEqual(relayCalls, []);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
    }),
  ),
);

it.effect("two overlapping updates are applied one after the other", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstAtRelay = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService({ holdFirstRelayCall: { started, released } }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      const first = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstAtRelay);
      const second = yield* preferences
        .update({ publishAgentActivity: false, holdWebhooksWhileOffline: false })
        .pipe(Effect.forkChild);
      // Give the second update every chance to run; it must wait for the first.
      yield* Effect.yieldNow;
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "true");
      release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  );
});

it.effect("changes nothing when the current hold setting can't be read", () =>
  withService({ failHoldRead: true, failHoldWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      stored.set(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, encode("true"));
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: false })
        .pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "CloudLinkInternalError", operation: "read-preferences" });
      assert.deepEqual(relayCalls, []);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
    }),
  ),
);

it.effect("an update the client walks away from still finishes", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atRelay = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService({ holdFirstRelayCall: { started, released } }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      const update = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => atRelay);
      // The interrupt is in flight before the relay answers.
      const interrupted = yield* Fiber.interrupt(update).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      release();
      yield* Fiber.join(interrupted);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "true");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  );
});

/**
 * The relay bakes the signed origin into the managed tunnel's ingress config,
 * and the connector reading it runs beside this server, so the signed port has
 * to be the one this process is bound to. A Docker Sandbox makes the two differ:
 * it is reached over `ssh -L 54321:127.0.0.1:3773`, so the request arrives on the
 * desktop-side 54321 while the connector inside the sandbox must dial 3773.
 */
const SERVER_PORT = 3773;
const FORWARDED_PORT = 54321;

const linkProofRequest = (claimedPort: number): RelayLinkProofRequest => ({
  challenge: "challenge",
  relayIssuer: "https://relay.example.test",
  endpoint: {
    httpBaseUrl: `http://127.0.0.1:${claimedPort}`,
    wsBaseUrl: `ws://127.0.0.1:${claimedPort}`,
    providerKind: "cloudflare_tunnel",
  },
  origin: { localHttpHost: "127.0.0.1", localHttpPort: claimedPort },
});

/** Arrived on `port` over loopback, with no proxy rewriting the authority. */
const requestArrivingOn = (port: number) =>
  ({
    originalUrl: `http://127.0.0.1:${port}/api/t3-connect/link-proof`,
    headers: {},
  }) as unknown as HttpServerRequest.HttpServerRequest;

const withLinkProof = <A, E>(
  body: (linkProof: CloudLink.CloudLink["Service"]["linkProof"]) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const link = yield* CloudLink.CloudLink;
    return yield* body(link.linkProof);
  }).pipe(
    Effect.provide(
      CloudLink.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getDescriptor: Effect.succeed({
                environmentId: EnvironmentId.make("environment-1"),
                label: "Test",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0",
                capabilities: { repositoryIdentity: false },
              }),
            }),
            Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({}),
            Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
            Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", SERVER_PORT),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unused")),
            ),
          ).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-link-proof-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

it.effect("signs this server's own listening port, not the port the request arrived on", () =>
  withLinkProof((linkProof) =>
    Effect.gen(function* () {
      const proof = yield* linkProof(
        linkProofRequest(FORWARDED_PORT),
        requestArrivingOn(FORWARDED_PORT),
      );

      assert.deepEqual(decodeRelayJwt(proof).origin, {
        localHttpHost: "127.0.0.1",
        localHttpPort: SERVER_PORT,
      });
    }),
  ),
);

it.effect("signs the same port a direct loopback caller reached", () =>
  withLinkProof((linkProof) =>
    Effect.gen(function* () {
      const proof = yield* linkProof(linkProofRequest(SERVER_PORT), requestArrivingOn(SERVER_PORT));

      assert.deepEqual(decodeRelayJwt(proof).origin, {
        localHttpHost: "127.0.0.1",
        localHttpPort: SERVER_PORT,
      });
    }),
  ),
);

// The claim is still checked against the arrival port, so a caller cannot steer
// the signed origin even by naming the port it wants the tunnel pointed at.
it.effect("refuses a claimed origin the request did not arrive on", () =>
  withLinkProof((linkProof) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        linkProof(linkProofRequest(SERVER_PORT), requestArrivingOn(FORWARDED_PORT)),
      );

      assert.equal(error._tag, "CloudLinkOriginInvalidError");
    }),
  ),
);

it.effect("refuses a non-loopback claimed origin", () =>
  withLinkProof((linkProof) =>
    Effect.gen(function* () {
      const request = linkProofRequest(FORWARDED_PORT);
      const error = yield* Effect.flip(
        linkProof(
          {
            ...request,
            origin: { localHttpHost: "attacker.example.test", localHttpPort: FORWARDED_PORT },
          },
          requestArrivingOn(FORWARDED_PORT),
        ),
      );

      assert.equal(error._tag, "CloudLinkOriginInvalidError");
    }),
  ),
);
