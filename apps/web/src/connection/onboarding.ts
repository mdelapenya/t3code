import {
  ConnectionOnboarding,
  type SshRegistrationResult,
} from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
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

/** Outcome of a background T3 Connect relay activation, once it settles. */
export interface SandboxRelayActivationOutcome {
  readonly linked: boolean;
}

/**
 * Registers a Docker Sandbox SSH environment and, when a Clerk token is
 * provided, schedules T3 Connect relay activation so the sandbox becomes
 * reachable from mobile and remote clients.
 *
 * The command resolves as soon as SSH registration finishes — it does not
 * wait on relay activation. When a Clerk token is available, relay
 * activation is forked into a detached fiber (`Effect.forkDetach`) that
 * keeps running after the command itself has resolved, so a slow or
 * unreachable relay never holds the "Add Environment" UI in a pending state.
 * `relayActivation` in the result tells the caller whether activation was
 * scheduled (`"pending"`, a token was available) or not attempted
 * (`"skipped"`, no token). It cannot yet say whether activation succeeded —
 * that only becomes known when the background fiber settles.
 *
 * Relay activation failure is non-fatal and never rolls back the SSH
 * registration: it is logged as a warning and, when a `onRelaySettled`
 * callback was supplied, reported through it exactly once, off the command's
 * own return path. `onRelaySettled` is only ever invoked when
 * `relayActivation` resolves to `"pending"`. There is no dedicated retry
 * control for the link, and the environment's own reconnect action
 * (`retryNow`) never re-attempts it — only removing the saved environment and
 * adding it again, which invokes this command again, does.
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
     * activation is scheduled automatically after SSH registration. When null
     * (user not signed in) registration proceeds without relay.
     */
    readonly clerkToken: string | null;
    /**
     * Called once, from the detached relay-activation fiber, when a
     * scheduled activation attempt settles. Never called when no token was
     * provided (`relayActivation: "skipped"`).
     */
    readonly onRelaySettled?: (outcome: SandboxRelayActivationOutcome) => void;
  }) =>
    Effect.gen(function* () {
      const onboarding = yield* ConnectionOnboarding;
      const registration: SshRegistrationResult = yield* onboarding.registerSsh({
        target: input.target,
        ...(input.label === undefined ? {} : { label: input.label }),
      });

      if (!input.clerkToken) {
        return { registration, relayActivation: "skipped" as const };
      }

      const target: CloudLinkTarget = {
        environmentId: registration.environmentId,
        label: input.label?.trim() || input.target.alias,
        httpBaseUrl: registration.httpBaseUrl,
        wsBaseUrl: registration.wsBaseUrl,
      };
      const onRelaySettled = input.onRelaySettled;

      yield* linkSandboxEnvironmentToCloud({
        target,
        clerkToken: input.clerkToken,
        bearerToken: registration.bearerToken,
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning(
            "Sandbox relay activation failed; SSH connection still succeeded.",
            safeErrorLogAttributes(error),
          ).pipe(Effect.as(false)),
        ),
        Effect.tap((linked) => Effect.sync(() => onRelaySettled?.({ linked }))),
        // Detached, not scoped/child: this fiber must keep running after the
        // command's own effect resolves below, so a slow relay cannot hold
        // the caller's promise (and the "Add Environment" UI) pending.
        Effect.forkDetach,
      );

      return { registration, relayActivation: "pending" as const };
    }),
});
