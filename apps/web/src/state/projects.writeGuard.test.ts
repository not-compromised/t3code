import { type DesktopWriteGuardState, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }
  globalThis.window = originalWindow;
});

const write = {
  environmentId: EnvironmentId.make("not-connected"),
  input: { cwd: "/m/app", relativePath: "CLAUDE.md", contents: "new\n" },
};

function failureOf(result: AsyncResult.AsyncResult<unknown, unknown>) {
  expect(result._tag).toBe("Failure");
  return Cause.squash((result as AsyncResult.Failure<unknown, unknown>).cause) as {
    readonly _tag?: string;
  };
}

async function writeThroughApp(state: DesktopWriteGuardState) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { desktopBridge: { getWriteGuard: async () => state } },
  });
  const { projectEnvironment, environmentProjects } = await import("./projects");
  const { connectionAtomRuntime } = await import("../connection/runtime");
  const { createProjectEnvironmentAtoms } = await import("@t3tools/client-runtime/state/projects");
  const stock = createProjectEnvironmentAtoms(connectionAtomRuntime, {
    projectAtom: environmentProjects.projectAtom,
  });
  return {
    guarded: failureOf(await projectEnvironment.writeFile.run(AtomRegistry.make(), write)),
    stock: failureOf(await stock.writeFile.run(AtomRegistry.make(), write)),
  };
}

const settingsPath = "/home/u/.t3/userdata/write-guard.json";

describe("the desktop app's project writes", () => {
  it("go through the write guard: a broken guard setting refuses before the server is asked", async () => {
    const { guarded } = await writeThroughApp({
      status: "invalid",
      settingsPath,
      protectedRepositories: [],
      problem: "it is not a regular file",
    });
    expect(guarded._tag).toBe("WriteGuardRefusedError");
  });

  it("with the guard off, end exactly as the stock write does", async () => {
    // No environment is connected, so both reach the connection layer and fail there.
    const { guarded, stock } = await writeThroughApp({
      status: "off",
      settingsPath,
      protectedRepositories: [],
      problem: null,
    });
    expect(guarded._tag).toBe(stock._tag);
    expect(guarded._tag).not.toBe("WriteGuardRefusedError");
  });
});
