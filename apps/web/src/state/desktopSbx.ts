import type { DesktopBridge, DesktopSbxStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

type DesktopSbxBridge = Pick<DesktopBridge, "probeSbx">;

class DesktopSbxUnavailableError extends Schema.TaggedError<DesktopSbxUnavailableError>()(
  "DesktopSbxUnavailableError",
  {},
) {
  override get message(): string {
    return "Docker Sandboxes are unavailable in this app.";
  }
}

class DesktopSbxProbeError extends Schema.TaggedError<DesktopSbxProbeError>()(
  "DesktopSbxProbeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check the Docker Sandboxes CLI.";
  }
}

function getDesktopSbxBridge(): DesktopSbxBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopSbxStateAtom(getBridge: () => DesktopSbxBridge | undefined) {
  const probeDesktopSbx = Effect.fn("probeDesktopSbx")(function* () {
    const probe = getBridge()?.probeSbx;
    if (!probe) {
      return yield* new DesktopSbxUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopSbxStatus> => probe(),
      catch: (cause) => new DesktopSbxProbeError({ cause }),
    });
  });

  return Atom.make(probeDesktopSbx()).pipe(
    Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
    Atom.keepAlive,
    Atom.withLabel("desktop:sbx-status"),
  );
}

export const desktopSbxStateAtom = createDesktopSbxStateAtom(getDesktopSbxBridge);
