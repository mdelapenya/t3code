import {
  DesktopSbxCreateInputSchema,
  DesktopSbxRemoveInputSchema,
  DesktopSbxStatusSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import * as DesktopSbxEnvironment from "../../sbx/DesktopSbxEnvironment.ts";

export const probeSbx = makeIpcMethod({
  channel: IpcChannels.PROBE_SBX_CHANNEL,
  payload: Schema.Void,
  result: DesktopSbxStatusSchema,
  handler: Effect.fn("desktop.ipc.sbx.probe")(function* () {
    const sbx = yield* DesktopSbxEnvironment.DesktopSbxEnvironment;
    return yield* sbx.probe;
  }),
});

export const installSbx = makeIpcMethod({
  channel: IpcChannels.INSTALL_SBX_CHANNEL,
  payload: Schema.Void,
  result: DesktopSbxStatusSchema,
  handler: Effect.fn("desktop.ipc.sbx.install")(function* () {
    const sbx = yield* DesktopSbxEnvironment.DesktopSbxEnvironment;
    return yield* sbx.install;
  }),
});

export const createSbxSandbox = makeIpcMethod({
  channel: IpcChannels.CREATE_SBX_SANDBOX_CHANNEL,
  payload: DesktopSbxCreateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sbx.create")(function* (input) {
    const sbx = yield* DesktopSbxEnvironment.DesktopSbxEnvironment;
    yield* sbx.create(input);
  }),
});

export const removeSbxSandbox = makeIpcMethod({
  channel: IpcChannels.REMOVE_SBX_SANDBOX_CHANNEL,
  payload: DesktopSbxRemoveInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sbx.remove")(function* ({ name }) {
    const sbx = yield* DesktopSbxEnvironment.DesktopSbxEnvironment;
    yield* sbx.remove(name);
  }),
});
