import {
  validateSbxSandboxName,
  type DesktopSbxCreateInput,
  type DesktopSbxStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  buildSbxCreateArgs,
  buildSbxInstallCommands,
  buildSbxListArgs,
  buildSbxRemoveArgs,
  buildSbxSetupSshArgs,
  buildSbxVersionArgs,
  formatSbxOutputTail,
  parseSbxListOutput,
  parseSbxVersionOutput,
  resolveSbxInstallMethod,
  sbxManualInstallCommands,
} from "./DesktopSbxCli.ts";

const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const PROBE_TIMEOUT = Duration.seconds(15);
const SETUP_SSH_TIMEOUT = Duration.seconds(30);
const REMOVE_TIMEOUT = Duration.minutes(2);
// Creation pulls the sandbox image and applies kits; installs go through a
// package manager. Both are network-bound and legitimately slow on first run.
const CREATE_TIMEOUT = Duration.minutes(10);
const INSTALL_TIMEOUT = Duration.minutes(10);

export class DesktopSbxCommandError extends Schema.TaggedError<DesktopSbxCommandError>()(
  "DesktopSbxCommandError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isDesktopSbxCommandError = Schema.is(DesktopSbxCommandError);

export class DesktopSbxEnvironment extends Context.Service<
  DesktopSbxEnvironment,
  {
    // Installed → version; ready → `sbx ls` works and the listing is included.
    readonly probe: Effect.Effect<DesktopSbxStatus>;
    // Runs the one-click installer for this host, then re-probes so callers
    // report the verified state instead of the installer's exit code.
    readonly install: Effect.Effect<DesktopSbxStatus, DesktopSbxCommandError>;
    // Ensures the managed *.sbx SSH config exists, then creates the sandbox.
    readonly create: (input: DesktopSbxCreateInput) => Effect.Effect<void, DesktopSbxCommandError>;
    readonly remove: (name: string) => Effect.Effect<void, DesktopSbxCommandError>;
  }
>()("@t3tools/desktop/sbx/DesktopSbxEnvironment") {}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  // "spawn" is the interesting one: the binary is not on PATH.
  readonly transportFailure: "timeout" | "spawn" | "process" | null;
}

const concatChunks = (arrays: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.byteLength;
  }
  return out;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

const TIMEOUT_RESULT: CommandResult = {
  exitCode: 124,
  stdout: "",
  stderr: "[timeout]",
  transportFailure: "timeout",
};

const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Duration,
): Effect.Effect<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnResult = yield* spawner
        .spawn(
          ChildProcess.make(command, args, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: PROCESS_TERMINATE_GRACE,
          }),
        )
        .pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure", error }) as const,
            onSuccess: (handle) => ({ _tag: "Success", handle }) as const,
          }),
        );
      if (spawnResult._tag === "Failure") {
        return {
          exitCode: 127,
          stdout: "",
          stderr: spawnResult.error.message,
          transportFailure: "spawn",
        } satisfies CommandResult;
      }
      const handle = spawnResult.handle;
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: exitCode as unknown as number,
        stdout: decodeUtf8(concatChunks(stdoutBytes)),
        stderr: decodeUtf8(concatChunks(stderrBytes)),
        transportFailure: null,
      } satisfies CommandResult;
    }),
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): CommandResult => TIMEOUT_RESULT)),
    Effect.catch((error) =>
      Effect.succeed<CommandResult>({
        exitCode: 127,
        stdout: "",
        stderr: error.message,
        transportFailure: "process",
      }),
    ),
  );

const runSbx = (args: ReadonlyArray<string>, timeout: Duration.Duration) =>
  runCommand("sbx", args, timeout);

const failedCommandReason = (
  description: string,
  result: CommandResult,
): DesktopSbxCommandError => {
  if (result.transportFailure === "timeout") {
    return new DesktopSbxCommandError({ reason: `${description} timed out.` });
  }
  const tail = formatSbxOutputTail(result);
  return new DesktopSbxCommandError({
    reason: tail.length > 0 ? `${description} failed: ${tail}` : `${description} failed.`,
  });
};

const probeImpl = (
  platform: NodeJS.Platform,
): Effect.Effect<DesktopSbxStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const manualInstallCommands = sbxManualInstallCommands(platform);
    const version = yield* runSbx(buildSbxVersionArgs(), PROBE_TIMEOUT);
    if (version.transportFailure === "spawn") {
      // Not on PATH. Decide whether one-click install is possible here; a
      // brew probe only matters on macOS.
      const brewAvailable =
        platform === "darwin"
          ? (yield* runCommand("brew", ["--version"], PROBE_TIMEOUT)).transportFailure === null
          : false;
      return {
        installed: false,
        version: null,
        ready: false,
        unreadyReason: null,
        installMethod: resolveSbxInstallMethod({ platform, brewAvailable }),
        manualInstallCommands,
        sandboxes: [],
      } satisfies DesktopSbxStatus;
    }

    const installedVersion = parseSbxVersionOutput(version.stdout);
    const listing = yield* runSbx(buildSbxListArgs(), PROBE_TIMEOUT);
    const sandboxes =
      listing.exitCode === 0 && listing.transportFailure === null
        ? parseSbxListOutput(listing.stdout)
        : null;
    if (sandboxes === null) {
      // Installed but not functional. When the command itself failed, surface
      // the CLI's own words — they carry the remediation ("sbx login", daemon
      // status) better than a guess. When it succeeded but the JSON was
      // unrecognizable, dumping it at the user helps nobody; name the actual
      // problem instead.
      const commandFailed = listing.exitCode !== 0 || listing.transportFailure !== null;
      return {
        installed: true,
        version: installedVersion,
        ready: false,
        unreadyReason: commandFailed
          ? formatSbxOutputTail(listing) || null
          : "The sandbox list from `sbx ls --json` was not in a format this T3 Code build understands. Updating sbx or T3 Code may resolve the mismatch.",
        installMethod: "manual",
        manualInstallCommands,
        sandboxes: [],
      } satisfies DesktopSbxStatus;
    }

    return {
      installed: true,
      version: installedVersion,
      ready: true,
      unreadyReason: null,
      installMethod: "manual",
      manualInstallCommands,
      sandboxes,
    } satisfies DesktopSbxStatus;
  });

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Installs, creates, and removals mutate shared host state (package
  // manager, daemon, SSH config); serialize them so double-clicks and
  // concurrent renderer calls cannot interleave.
  const mutations = yield* Semaphore.make(1);

  const provideSpawner = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  ): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const probe = provideSpawner(probeImpl(environment.platform)).pipe(
    Effect.withSpan("desktop.sbx.probe"),
  );

  const install = mutations
    .withPermits(1)(
      Effect.gen(function* () {
        const status = yield* probe;
        if (status.installed) return status;
        const commands = buildSbxInstallCommands(status.installMethod);
        if (commands.length === 0) {
          return yield* new DesktopSbxCommandError({
            reason:
              "One-click install is not available on this system. Follow the install commands shown in the dialog instead.",
          });
        }
        for (const step of commands) {
          const result = yield* provideSpawner(
            runCommand(step.command, step.args, INSTALL_TIMEOUT),
          );
          if (result.transportFailure !== null || result.exitCode !== 0) {
            return yield* failedCommandReason(`\`${step.command} ${step.args.join(" ")}\``, result);
          }
        }
        // Verify, then report: the fresh probe (not the installer's exit
        // code) is what the UI shows next.
        return yield* probe;
      }),
    )
    .pipe(Effect.withSpan("desktop.sbx.install"));

  const ensureSshSetup = Effect.gen(function* () {
    const result = yield* provideSpawner(runSbx(buildSbxSetupSshArgs(), SETUP_SSH_TIMEOUT));
    if (result.transportFailure !== null || result.exitCode !== 0) {
      return yield* failedCommandReason("`sbx setup ssh`", result);
    }
  });

  const create = (input: DesktopSbxCreateInput) =>
    mutations
      .withPermits(1)(
        Effect.gen(function* () {
          const nameError = validateSbxSandboxName(input.name);
          if (nameError !== null) {
            return yield* new DesktopSbxCommandError({ reason: nameError });
          }
          // Idempotent, and required exactly once per machine for <name>.sbx
          // hosts to resolve — running it before every create keeps the flow
          // self-healing when the user removed the managed SSH config.
          yield* ensureSshSetup;
          const result = yield* provideSpawner(
            runSbx(
              buildSbxCreateArgs({
                name: input.name.trim(),
                agent: input.agent,
                workspacePath: input.workspacePath,
                kits: input.kits,
              }),
              CREATE_TIMEOUT,
            ),
          );
          if (result.transportFailure !== null || result.exitCode !== 0) {
            return yield* failedCommandReason(`Creating sandbox “${input.name.trim()}”`, result);
          }
        }),
      )
      .pipe(Effect.withSpan("desktop.sbx.create"));

  const remove = (name: string) =>
    mutations
      .withPermits(1)(
        Effect.gen(function* () {
          const result = yield* provideSpawner(runSbx(buildSbxRemoveArgs(name), REMOVE_TIMEOUT));
          if (result.transportFailure !== null || result.exitCode !== 0) {
            return yield* failedCommandReason(`Removing sandbox “${name}”`, result);
          }
        }),
      )
      .pipe(Effect.withSpan("desktop.sbx.remove"));

  return DesktopSbxEnvironment.of({ probe, install, create, remove });
});

export const layer = Layer.effect(DesktopSbxEnvironment, make);

export interface DesktopSbxEnvironmentTestStub {
  readonly probe?: DesktopSbxStatus;
  readonly installResult?: DesktopSbxStatus | DesktopSbxCommandError;
  readonly createError?: DesktopSbxCommandError;
  readonly removeError?: DesktopSbxCommandError;
}

const EMPTY_STATUS: DesktopSbxStatus = {
  installed: false,
  version: null,
  ready: false,
  unreadyReason: null,
  installMethod: "manual",
  manualInstallCommands: [],
  sandboxes: [],
};

export const layerTest = (stub: DesktopSbxEnvironmentTestStub = {}) =>
  Layer.succeed(
    DesktopSbxEnvironment,
    DesktopSbxEnvironment.of({
      probe: Effect.succeed(stub.probe ?? EMPTY_STATUS),
      install:
        stub.installResult !== undefined && isDesktopSbxCommandError(stub.installResult)
          ? Effect.fail(stub.installResult)
          : Effect.succeed(stub.installResult ?? stub.probe ?? EMPTY_STATUS),
      create: () => (stub.createError ? Effect.fail(stub.createError) : Effect.void),
      remove: () => (stub.removeError ? Effect.fail(stub.removeError) : Effect.void),
    }),
  );
