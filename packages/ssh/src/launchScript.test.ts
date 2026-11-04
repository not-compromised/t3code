import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildRemoteLaunchScript } from "./tunnel.ts";

// Stands in for both the background service's server and a server the launch
// starts itself, so the real launch script runs end to end under `sh`.
const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const fakeDir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const server = http.createServer((_request, response) => response.end("ok"));
if (args[0] === "service") {
  const home = args[1];
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "userdata", "server-runtime.json"),
      JSON.stringify({ pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
    );
    fs.writeFileSync(path.join(fakeDir, "service.pid"), String(process.pid));
  });
} else {
  const port = Number(args[args.indexOf("--port") + 1]);
  server.listen(port, "127.0.0.1", () => {
    fs.writeFileSync(path.join(fakeDir, "launched.pid"), String(process.pid));
  });
}
`;

// Reports the unit as activating and brings its server up, the way a service
// looks while it switches servers during a restart or update.
const FAKE_SYSTEMCTL = `#!/bin/sh
if [ -f "$FAKE_DIR/service-installed" ]; then
  if [ ! -f "$FAKE_DIR/service-started" ]; then
    : >"$FAKE_DIR/service-started"
    node "$FAKE_SERVER" service "$HOME/.t3" >/dev/null 2>&1 &
  fi
  echo activating
  exit 3
fi
echo inactive
exit 3
`;

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );

const launchOnFakeRemote = Effect.fn("launchOnFakeRemote")(function* (options: {
  readonly withService: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-launch-" });
  const home = path.join(root, "home");
  const fakeDir = path.join(root, "fake");
  const bin = path.join(root, "bin");
  for (const dir of [home, fakeDir, bin]) yield* fs.makeDirectory(dir, { recursive: true });
  const fakeServer = path.join(root, "fake-server.cjs");
  yield* fs.writeFileString(fakeServer, FAKE_SERVER);
  yield* fs.writeFileString(path.join(bin, "systemctl"), FAKE_SYSTEMCTL);
  yield* fs.chmod(path.join(bin, "systemctl"), 0o755);
  if (options.withService) {
    yield* fs.makeDirectory(path.join(home, ".t3", "runtime"), { recursive: true });
    yield* fs.writeFileString(
      path.join(home, ".t3", "runtime", "service-state.json"),
      JSON.stringify({ protocol: 3, activeVersion: "1.2.3" }),
    );
    yield* fs.writeFileString(path.join(fakeDir, "service-installed"), "");
  }

  const pidAt = (name: string) =>
    fs.readFileString(path.join(fakeDir, name)).pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => undefined),
    );
  // Registered after the temp directory, so it stops the servers before the directory goes.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(["service.pid", "launched.pid"], (name) =>
      pidAt(name).pipe(
        Effect.flatMap((pid) =>
          Effect.sync(() => {
            if (pid === undefined) return;
            try {
              process.kill(pid);
            } catch {}
          }),
        ),
      ),
    ),
  );

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("sh", ["-s", "--", "test-state-key"], {
      env: {
        HOME: home,
        PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        FAKE_DIR: fakeDir,
        FAKE_SERVER: fakeServer,
      },
      extendEnv: false,
      stdin: {
        stream: Stream.make(
          new TextEncoder().encode(buildRemoteLaunchScript({ nodeScriptPath: fakeServer })),
        ),
        endOnDone: true,
      },
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectText(child.stdout), collectText(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  assert.equal(Number(exitCode), 0, stderr);
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
    readonly remotePort: number;
    readonly serverKind: string;
  };
  const runtime = yield* fs
    .readFileString(path.join(home, ".t3", "userdata", "server-runtime.json"))
    .pipe(
      Effect.map((text) => JSON.parse(text) as { readonly port: number }),
      Effect.orElseSucceed(() => undefined),
    );
  return { result, servicePort: runtime?.port, launchedPid: yield* pidAt("launched.pid") };
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("remote launch script", () => {
  it.effect("waits for a restarting background service instead of starting its own server", () =>
    Effect.gen(function* () {
      const { result, servicePort, launchedPid } = yield* launchOnFakeRemote({
        withService: true,
      });
      assert.equal(result.serverKind, "external");
      assert.equal(result.remotePort, servicePort);
      assert.isUndefined(launchedPid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts its own server right away when the home has no background service", () =>
    Effect.gen(function* () {
      const { result, launchedPid } = yield* launchOnFakeRemote({ withService: false });
      assert.equal(result.serverKind, "managed");
      assert.isDefined(launchedPid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
