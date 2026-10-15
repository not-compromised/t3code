import { type DesktopWriteGuardState, EnvironmentId } from "@t3tools/contracts";
import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  guardWriteFile,
  type ProjectWriteRequest,
  WriteGuardRefusedError,
  type WriteGuardPorts,
  type WriteGuardRefusal,
} from "./guardedWriteFile";
import type { GuardRead } from "./protectedCheckouts";

const environmentId = EnvironmentId.make("write-guard-test");

function request(relativePath: string, contents = "new\n"): ProjectWriteRequest {
  return { environmentId, input: { cwd: "/m/app", relativePath, contents } };
}

function serverCommand() {
  const calls: ProjectWriteRequest[] = [];
  const results: AtomCommandResult<{ relativePath: string }, never>[] = [];
  const command: AtomCommand<ProjectWriteRequest, { relativePath: string }, never> = {
    label: "projects.writeFile",
    run: async (_registry, value) => {
      calls.push(value);
      const result = AsyncResult.success({ relativePath: value.input.relativePath });
      results.push(result);
      return result;
    },
  };
  return { command, calls, results };
}

const on: DesktopWriteGuardState = {
  status: "on",
  settingsPath: "/home/u/.t3/userdata/write-guard.json",
  protectedRepositories: ["github.com/owner/tools"],
  problem: null,
};

/** /m/app/CLAUDE.md links to a file in the protected checkout /m/tools. */
const machine: Record<string, GuardRead> = {
  "CLAUDE.md": { kind: "escapes", realPath: "/m/tools/ctx/AGENTS.md" },
  "src/main.ts": { kind: "file", contents: "export {};\n", truncated: false },
  "/m/app": { kind: "directory", realPath: "/m/app" },
  "/m/app/src": { kind: "directory", realPath: "/m/app/src" },
  "/m/app/.git": { kind: "directory", realPath: "/m/app/.git" },
  "/m/app/.git/config": {
    kind: "file",
    contents: '[remote "origin"]\n\turl = git@github.com:owner/app.git\n',
    truncated: false,
  },
  "/m/tools/.git": { kind: "directory", realPath: "/m/tools/.git" },
  "/m/tools/.git/config": {
    kind: "file",
    contents: '[remote "origin"]\n\turl = git@github.com:owner/tools.git\n',
    truncated: false,
  },
  "/m/tools/ctx/AGENTS.md": { kind: "file", contents: "old\n", truncated: false },
};

/** Regular files per workspace directory; CLAUDE.md is a link, so it is never listed. */
const listings: Record<string, string[]> = { "": [], src: ["main.ts"] };

function ports(overrides: Partial<WriteGuardPorts> = {}) {
  const notices: WriteGuardRefusal[] = [];
  const reads: string[] = [];
  const value: WriteGuardPorts = {
    getState: async () => on,
    read: async (_registry, _environmentId, input) => {
      reads.push(input.relativePath);
      return machine[input.relativePath] ?? { kind: "missing" };
    },
    listFiles: async (_registry, _environmentId, input) => ({
      kind: "listed",
      files: listings[input.directoryPath] ?? [],
    }),
    notify: (notice) => notices.push(notice),
    now: () => 0,
    ...overrides,
  };
  return { value, notices, reads };
}

describe("guarded project writes", () => {
  it("leaves the write command untouched outside the desktop app", () => {
    const { command } = serverCommand();
    expect(guardWriteFile(command, ports({ getState: null }).value)).toBe(command);
  });

  it("with the guard off, passes every write to the server exactly as made", async () => {
    const { command, calls, results } = serverCommand();
    const port = ports({ getState: async () => ({ ...on, status: "off" }) });
    const registry = AtomRegistry.make();
    const write = request("CLAUDE.md");

    const result = await guardWriteFile(command, port.value).run(registry, write);

    expect(calls).toEqual([write]);
    expect(calls[0]).toBe(write);
    expect(result).toBe(results[0]);
    expect(port.reads).toEqual([]);
    expect(port.notices).toEqual([]);
  });

  it("with the guard on, refuses a write through a link into a protected checkout and shows the change", async () => {
    const { command, calls } = serverCommand();
    const port = ports();

    const result = await guardWriteFile(command, port.value).run(
      AtomRegistry.make(),
      request("CLAUDE.md"),
    );

    expect(calls).toEqual([]);
    expect(result._tag).toBe("Failure");
    const error = Cause.squash((result as AsyncResult.Failure<unknown, unknown>).cause);
    expect(error).toBeInstanceOf(WriteGuardRefusedError);
    expect(port.notices).toHaveLength(1);
    expect(port.notices[0]!.title).toBe("Not saved: this file is in a protected checkout");
    expect(port.notices[0]!.description).toBe(
      [
        "/m/app/CLAUDE.md leads to /m/tools/ctx/AGENTS.md, inside /m/tools, a checkout of github.com/owner/tools. The write guard is on, so T3 did not write it. Ask the owner to approve this change, or remove /home/u/.t3/userdata/write-guard.json to switch the guard off.",
        "",
        "Attempted change:",
        "--- /m/tools/ctx/AGENTS.md",
        "+++ /m/tools/ctx/AGENTS.md",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  it("with the guard on, lets a write outside protected checkouts through", async () => {
    const { command, calls } = serverCommand();
    const write = request("src/main.ts");
    const result = await guardWriteFile(command, ports().value).run(AtomRegistry.make(), write);
    expect(calls).toEqual([write]);
    expect(result._tag).toBe("Success");
  });

  it("refuses every write while the guard's settings file is broken, and names it", async () => {
    const { command, calls } = serverCommand();
    const port = ports({
      getState: async () => ({
        status: "invalid",
        settingsPath: "/home/u/.t3/userdata/write-guard.json",
        protectedRepositories: [],
        problem: "it is not a regular file",
      }),
    });

    const result = await guardWriteFile(command, port.value).run(
      AtomRegistry.make(),
      request("src/main.ts"),
    );

    expect(calls).toEqual([]);
    expect(result._tag).toBe("Failure");
    expect(port.notices[0]!.description).toContain(
      "/home/u/.t3/userdata/write-guard.json is invalid: it is not a regular file.",
    );
  });

  it("keeps writes to one file in the order they were made when checks take different times", async () => {
    const { command, calls } = serverCommand();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held = false;
    const port = ports({
      read: async (_registry, _environmentId, input) => {
        if (!held) {
          held = true;
          await firstHeld;
        }
        return machine[input.relativePath] ?? { kind: "missing" };
      },
      now: (() => {
        let clock = 0;
        // Each check outlives the cache, so both writes are checked.
        return () => (clock += 60_000);
      })(),
    });
    const guarded = guardWriteFile(command, port.value);
    const registry = AtomRegistry.make();

    const first = guarded.run(registry, request("src/main.ts", "first\n"));
    const second = guarded.run(registry, request("src/main.ts", "second\n"));
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls.map((call) => call.input.contents)).toEqual(["first\n", "second\n"]);
  });

  it("re-checks an allowed file once its verdict is older than the cache window", async () => {
    const { command, calls } = serverCommand();
    let clock = 0;
    const port = ports({ now: () => clock });
    const guarded = guardWriteFile(command, port.value);
    const registry = AtomRegistry.make();

    await guarded.run(registry, request("src/main.ts"));
    const readsAfterFirst = port.reads.length;
    await guarded.run(registry, request("src/main.ts"));
    expect(port.reads.length).toBe(readsAfterFirst);
    clock = 10_001;
    await guarded.run(registry, request("src/main.ts"));
    expect(port.reads.length).toBe(readsAfterFirst * 2);
    expect(calls).toHaveLength(3);
  });

  it("keeps one notice per refused file", async () => {
    const { command } = serverCommand();
    const port = ports();
    const guarded = guardWriteFile(command, port.value);
    const registry = AtomRegistry.make();

    await guarded.run(registry, request("CLAUDE.md", "one\n"));
    await guarded.run(registry, request("CLAUDE.md", "two\n"));

    expect(port.notices.map((notice) => notice.key)).toEqual([
      port.notices[0]!.key,
      port.notices[0]!.key,
    ]);
    expect(port.notices[1]!.description).toContain("+two");
  });

  it("reports a write through a not-yet-existing link once it lands in a protected checkout", async () => {
    const files: Record<string, GuardRead> = { ...machine };
    const command: AtomCommand<ProjectWriteRequest, { relativePath: string }, never> = {
      label: "projects.writeFile",
      run: async (_registry, value) => {
        // The server follows the dangling link and creates its target.
        files["NEW.md"] = { kind: "escapes", realPath: "/m/tools/ctx/NEW.md" };
        files["/m/tools/ctx/NEW.md"] = { kind: "file", contents: "new\n", truncated: false };
        return AsyncResult.success({ relativePath: value.input.relativePath });
      },
    };
    const port = ports({
      read: async (_registry, _environmentId, input) =>
        files[input.relativePath] ?? { kind: "missing" },
    });

    const result = await guardWriteFile(command, port.value).run(
      AtomRegistry.make(),
      request("NEW.md"),
    );

    expect(result._tag).toBe("Success");
    expect(port.notices).toHaveLength(1);
    expect(port.notices[0]!.title).toBe("Saved into a protected checkout through a link");
    expect(port.notices[0]!.description).toContain(
      "T3 created /m/tools/ctx/NEW.md inside /m/tools, a checkout of github.com/owner/tools",
    );
    expect(port.notices[0]!.description).toContain("+new");
  });

  it("accepts a newly created link inside its own unprotected directory", async () => {
    const files: Record<string, GuardRead> = { ...machine };
    const command: AtomCommand<ProjectWriteRequest, { relativePath: string }, never> = {
      label: "projects.writeFile",
      run: async (_registry, value) => {
        // Created through a link that points elsewhere in its own directory.
        files["NEW.md"] = { kind: "file", contents: "new\n", truncated: false };
        return AsyncResult.success({ relativePath: value.input.relativePath });
      },
    };
    const port = ports({
      read: async (_registry, _environmentId, input) =>
        files[input.relativePath] ?? { kind: "missing" },
    });

    const result = await guardWriteFile(command, port.value).run(
      AtomRegistry.make(),
      request("NEW.md"),
    );

    expect(result._tag).toBe("Success");
    expect(port.notices).toEqual([]);
  });

  it("refuses every write while a protected repository is named incompletely", async () => {
    const { command, calls } = serverCommand();
    const port = ports({
      getState: async () => ({ ...on, protectedRepositories: ["owner/tools"] }),
    });

    const result = await guardWriteFile(command, port.value).run(
      AtomRegistry.make(),
      request("src/main.ts"),
    );

    expect(calls).toEqual([]);
    expect(result._tag).toBe("Failure");
    expect(port.notices[0]!.description).toContain(
      '"owner/tools" does not name a repository the way github.com/owner/repo does',
    );
  });

  it("checks a not-yet-existing target again on every write", async () => {
    const { command, calls } = serverCommand();
    const port = ports();
    const guarded = guardWriteFile(command, port.value);
    const registry = AtomRegistry.make();

    await guarded.run(registry, request("src/new.ts"));
    const readsAfterFirst = port.reads.length;
    await guarded.run(registry, request("src/new.ts"));

    expect(port.reads.length).toBe(readsAfterFirst * 2);
    expect(port.notices).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("refuses when the desktop app cannot report the guard's state", async () => {
    const { command, calls } = serverCommand();
    const port = ports({ getState: vi.fn(async () => Promise.reject(new Error("ipc closed"))) });
    const result = await guardWriteFile(command, port.value).run(
      AtomRegistry.make(),
      request("src/main.ts"),
    );
    expect(calls).toEqual([]);
    expect(result._tag).toBe("Failure");
  });
});

describe("default desktop write ports", () => {
  it.each(["missing method", "wrong directory", "absolute entry"])(
    "refuses a write with %s",
    async (scenario) => {
      vi.resetModules();
      vi.stubGlobal("window", {
        desktopBridge: scenario === "missing method" ? {} : { getWriteGuard: async () => on },
      });
      vi.doMock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
      vi.doMock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
        createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => ({
          run: async () =>
            AsyncResult.success(
              options.tag === "projects.listEntries"
                ? {
                    entries: [
                      {
                        kind: "file",
                        path: scenario === "absolute entry" ? "/main.ts" : "elsewhere/main.ts",
                      },
                    ],
                  }
                : { contents: "old\n", truncated: false },
            ),
        }),
      }));
      try {
        const { guardWriteFile: guard } = await import("./guardedWriteFile");
        const { command, calls } = serverCommand();
        const result = await guard(command).run(
          AtomRegistry.make(),
          request(scenario === "absolute entry" ? "main.ts" : "src/main.ts"),
        );
        expect(result._tag).toBe("Failure");
        expect(calls).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
        vi.doUnmock("../components/ui/toast");
        vi.doUnmock("@t3tools/client-runtime/state/runtime");
        vi.resetModules();
      }
    },
  );
});
