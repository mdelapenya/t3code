import type { DesktopSbxStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopSbxStateAtom } from "./desktopSbx";

const status: DesktopSbxStatus = {
  installed: true,
  version: "sbx version 0.4.0",
  ready: true,
  unreadyReason: null,
  installMethod: "manual",
  manualInstallCommands: ["brew trust docker/tap", "brew install docker/tap/sbx"],
  sandboxes: [{ name: "t3sbx", agent: "claude", status: "running", workspaces: [] }],
};

describe("desktopSbxState", () => {
  it("retains the probed status when the settings screen remounts", async () => {
    const probeSbx = vi.fn(async () => status);
    const atom = createDesktopSbxStateAtom(() => ({ probeSbx }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: status }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "Some", value: status }),
    );
    expect(probeSbx).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("fails as unavailable when the bridge lacks the sbx methods", async () => {
    const atom = createDesktopSbxStateAtom(() => ({}));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected the sbx probe to fail.");

    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({ _tag: "DesktopSbxUnavailableError" }),
    );
    registry.dispose();
  });

  it("retains the desktop bridge failure as the probe error cause", async () => {
    const cause = new Error("sbx exploded");
    const atom = createDesktopSbxStateAtom(() => ({
      probeSbx: async () => Promise.reject(cause),
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected the sbx probe to fail.");

    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({
        _tag: "DesktopSbxProbeError",
        cause,
      }),
    );
    registry.dispose();
  });
});
