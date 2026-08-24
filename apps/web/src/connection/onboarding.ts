import {
  ConnectionOnboarding,
  type SshRegistrationResult,
} from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";
import { linkSandboxEnvironmentToCloud, type CloudLinkTarget } from "../cloud/linkEnvironment";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { pairingUrl?: string; host?: string; pairingCode?: string }) =>
      JSON.stringify(input),
  },
  execute: (input: {
    readonly pairingUrl?: string;
    readonly host?: string;
    readonly pairingCode?: string;
  }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerPairing(input))),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: { readonly target: DesktopSshEnvironmentTarget; readonly label?: string }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerSsh(input))),
});

/**
 * Registers a Docker Sandbox SSH environment and, when a Clerk token is
 * provided, immediately activates T3 Connect relay so the sandbox is reachable
 * from mobile and remote clients.
 *
 * Relay activation is fire-and-forget: a failure is logged as a warning and
 * does not roll back the SSH registration. The user can retry via the T3
 * Connect toggle on the environment settings page.
 */
export const connectAndLinkSandboxEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-and-link-sandbox",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly label?: string;
    /**
     * Clerk token for the signed-in T3 Connect user. When provided relay
     * activation is attempted automatically after SSH registration. When null
     * (user not signed in) registration proceeds without relay.
     */
    readonly clerkToken: string | null;
  }) =>
    Effect.gen(function* () {
      const onboarding = yield* ConnectionOnboarding;
      const registration: SshRegistrationResult = yield* onboarding.registerSsh({
        target: input.target,
        ...(input.label === undefined ? {} : { label: input.label }),
      });

      if (input.clerkToken) {
        const target: CloudLinkTarget = {
          environmentId: registration.environmentId,
          label: input.label?.trim() || input.target.alias,
          httpBaseUrl: registration.httpBaseUrl,
          wsBaseUrl: registration.wsBaseUrl,
        };
        yield* linkSandboxEnvironmentToCloud({
          target,
          clerkToken: input.clerkToken,
          bearerToken: registration.bearerToken,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Sandbox relay activation failed; SSH connection still succeeded.", {
              message: error.message,
              cause: error.cause,
            }),
          ),
        );
      }

      return registration;
    }),
});
