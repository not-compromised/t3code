import { DesktopWriteGuardStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopWriteGuard from "../../writeGuard/DesktopWriteGuard.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getWriteGuard = makeIpcMethod({
  channel: IpcChannels.GET_WRITE_GUARD_CHANNEL,
  payload: Schema.Void,
  result: DesktopWriteGuardStateSchema,
  handler: Effect.fn("desktop.ipc.writeGuard.get")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settingsPath = environment.path.join(
      environment.stateDir,
      DesktopWriteGuard.WRITE_GUARD_SETTINGS_FILE,
    );
    return yield* Effect.sync(() => DesktopWriteGuard.readWriteGuardState(settingsPath));
  }),
});
