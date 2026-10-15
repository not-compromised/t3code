// @effect-diagnostics nodeBuiltinImport:off -- builds settings files, links and FIFOs on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DesktopWriteGuardState } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { getWriteGuard } from "../ipc/methods/writeGuard.ts";

vi.mock("electron", () => ({}));

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

/** A packaged desktop app whose T3 home is a fresh directory. */
function desktop() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-write-guard-"));
  homes.push(home);
  const stateDir = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const layer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: home,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
    ),
  );
  const settingsPath = NodePath.join(stateDir, "write-guard.json");
  // The handler returns what crosses the bridge to the renderer, typed unknown.
  const read = getWriteGuard.handler(undefined).pipe(
    Effect.map((state) => state as DesktopWriteGuardState),
    Effect.provide(layer),
  );
  return { home, settingsPath, read };
}

const invalidProblem =
  'it must be JSON of the form {"protectedRepositories": ["<repository>", ...]} naming at least one repository';

describe("desktop write guard switch", () => {
  it.effect("is off while its settings file is absent", () => {
    const { settingsPath, read } = desktop();
    return Effect.gen(function* () {
      assert.deepEqual(yield* read, {
        status: "off",
        settingsPath,
        protectedRepositories: [],
        problem: null,
      });
    });
  });

  it.effect("turns on when the file appears, with no restart", () => {
    const { settingsPath, read } = desktop();
    return Effect.gen(function* () {
      assert.strictEqual((yield* read).status, "off");
      NodeFS.writeFileSync(
        settingsPath,
        JSON.stringify({ protectedRepositories: [" github.com/owner/tools "] }),
      );
      assert.deepEqual(yield* read, {
        status: "on",
        settingsPath,
        protectedRepositories: ["github.com/owner/tools"],
        problem: null,
      });
      NodeFS.rmSync(settingsPath);
      assert.strictEqual((yield* read).status, "off");
    });
  });

  it.effect("follows a link to the settings file", () => {
    const { home, settingsPath, read } = desktop();
    return Effect.gen(function* () {
      const managed = NodePath.join(home, "managed.json");
      NodeFS.writeFileSync(managed, JSON.stringify({ protectedRepositories: ["github.com/o/t"] }));
      NodeFS.symlinkSync(managed, settingsPath);
      assert.deepEqual((yield* read).protectedRepositories, ["github.com/o/t"]);
    });
  });

  it.effect("reports a link to a missing settings file as invalid, not off", () => {
    const { home, settingsPath, read } = desktop();
    return Effect.gen(function* () {
      NodeFS.symlinkSync(NodePath.join(home, "moved.json"), settingsPath);
      assert.deepEqual(yield* read, {
        status: "invalid",
        settingsPath,
        protectedRepositories: [],
        problem: "it is a link to a file that does not exist",
      });
    });
  });

  it.effect("reports a settings file it cannot use as invalid, never as off", () => {
    const { settingsPath, read } = desktop();
    return Effect.gen(function* () {
      for (const contents of [
        "not json",
        "{}",
        JSON.stringify({ protectedRepositories: [] }),
        JSON.stringify({ protectedRepositories: ["  "] }),
        JSON.stringify({ protectedRepositories: ["github.com/o/t"], protectedRepos: [] }),
        JSON.stringify({ protectedRepositories: "github.com/o/t" }),
      ]) {
        NodeFS.writeFileSync(settingsPath, contents);
        assert.deepEqual(yield* read, {
          status: "invalid",
          settingsPath,
          protectedRepositories: [],
          problem: invalidProblem,
        });
      }
      NodeFS.writeFileSync(settingsPath, " ".repeat(16 * 1024 + 1));
      assert.strictEqual((yield* read).status, "invalid");
      NodeFS.rmSync(settingsPath);
      NodeFS.mkdirSync(settingsPath);
      assert.deepEqual(yield* read, {
        status: "invalid",
        settingsPath,
        protectedRepositories: [],
        problem: "it is not a regular file",
      });
    });
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "does not hang on a FIFO in its place",
    () => {
      const { settingsPath, read } = desktop();
      return Effect.gen(function* () {
        NodeChildProcess.execFileSync("mkfifo", [settingsPath]);
        assert.strictEqual((yield* read).status, "invalid");
      });
    },
  );
});
