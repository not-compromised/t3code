// @effect-diagnostics nodeBuiltinImport:off -- builds real checkouts and links on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  checkProjectWrite,
  classifyReadFailure,
  formatAttemptedChange,
  type GuardProbe,
  type GuardRead,
} from "./protectedCheckouts";

/**
 * Answers the guard's two probes the way the stock server does
 * (apps/server/src/workspace/WorkspaceFileSystem.ts resolveReadTarget and
 * readFile; WorkspaceEntries.ts list with a directoryPath): a relative read
 * must stay inside the real `cwd`, links included, and an absolute one is read
 * in place; failures carry the same `failure`, `operation` and `resolvedPath`
 * fields over the wire. A listing names the directory's own regular files and
 * directories, never its links, and refuses a directory outside the workspace.
 */
function serverProbe(workspace: string): GuardProbe {
  const fail = (fields: Record<string, unknown>) => ({
    _tag: "ProjectReadFileError",
    message: "read failed",
    ...fields,
  });
  // The server's input schemas trim every path it is sent.
  const readFile = async (requested: string, untrimmedCwd: string): Promise<string> => {
    const path = requested.trim();
    const cwd = untrimmedCwd.trim();
    let realTarget: string;
    if (NodePath.isAbsolute(path)) {
      realTarget = await NodeFSP.realpath(path).catch((cause) => {
        throw fail({ failure: "operation_failed", operation: "realpath-target", cause });
      });
    } else {
      const absolute = NodePath.resolve(cwd, path);
      const lexical = NodePath.relative(cwd, absolute);
      if (lexical === "" || lexical === ".." || lexical.startsWith("../")) {
        throw fail({ failure: "workspace_path_outside_root" });
      }
      const realRoot = await NodeFSP.realpath(cwd).catch((cause) => {
        throw fail({ failure: "operation_failed", operation: "realpath-workspace-root", cause });
      });
      realTarget = await NodeFSP.realpath(absolute).catch((cause) => {
        throw fail({ failure: "operation_failed", operation: "realpath-target", cause });
      });
      const real = NodePath.relative(realRoot, realTarget);
      if (real === ".." || real.startsWith("../") || NodePath.isAbsolute(real)) {
        throw fail({ failure: "resolved_path_outside_root", resolvedPath: realTarget });
      }
    }
    if (!(await NodeFSP.stat(realTarget)).isFile()) {
      throw fail({ failure: "path_not_file", resolvedPath: realTarget });
    }
    const bytes = await NodeFSP.readFile(realTarget);
    if (bytes.includes(0)) throw fail({ failure: "binary_file", resolvedPath: realTarget });
    return bytes.toString("utf8");
  };
  return {
    read: (path, cwd = workspace) =>
      readFile(path, cwd).then(
        (contents): GuardRead => ({ kind: "file", contents, truncated: false }),
        classifyReadFailure,
      ),
    listFiles: async (directoryPath) => {
      try {
        const root = await NodeFSP.realpath(workspace);
        const directory = await NodeFSP.realpath(NodePath.resolve(workspace, directoryPath.trim()));
        const inside = NodePath.relative(root, directory);
        if (inside.startsWith("..") || inside.split(NodePath.sep).includes(".git")) {
          return {
            kind: "failed",
            detail: "Directory must be inside the workspace and outside .git.",
          };
        }
        const children = await NodeFSP.readdir(directory, { withFileTypes: true });
        return {
          kind: "listed",
          files: children.filter((child) => child.isFile()).map((child) => child.name),
        };
      } catch (cause) {
        return { kind: "failed", detail: String(cause) };
      }
    },
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

async function write(path: string, contents: string) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, contents);
}

/** A protected checkout, one of its worktrees, and a project linked into it. */
async function makeMachine() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-write-guard-")),
  );
  roots.push(root);
  const tools = NodePath.join(root, "tools");
  await write(
    NodePath.join(tools, ".git", "config"),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:owner/tools.git\n',
  );
  await write(NodePath.join(tools, "context", "projects", "app", "AGENTS.md"), "# app\nold\n");
  await write(NodePath.join(tools, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const worktree = NodePath.join(root, "worktrees", "tools-wt");
  await write(
    NodePath.join(worktree, ".git"),
    `gitdir: ${NodePath.join(tools, ".git", "worktrees", "wt")}\n`,
  );
  const app = NodePath.join(root, "app");
  await write(
    NodePath.join(app, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/owner/app.git\n',
  );
  await write(NodePath.join(app, "src", "main.ts"), "export {};\n");
  await NodeFSP.symlink(
    NodePath.join(tools, "context", "projects", "app", "AGENTS.md"),
    NodePath.join(app, "CLAUDE.md"),
  );
  await NodeFSP.symlink(
    NodePath.join(tools, "context", "projects", "app"),
    NodePath.join(app, "context"),
  );
  const toolsLink = NodePath.join(root, "tools-link");
  await NodeFSP.symlink(tools, toolsLink);
  return { root, tools, worktree, app, toolsLink };
}

const protectedTools = ["github.com/owner/tools"];

function check(cwd: string, relativePath: string, protectedRepositories = protectedTools) {
  return checkProjectWrite(
    { cwd, relativePath },
    { protectedRepositories, probe: serverProbe(cwd) },
  );
}

describe("protected checkout write check", () => {
  it("fails closed when .git/config cannot be resolved due to permissions", async () => {
    const { tools } = await makeMachine();
    await write(NodePath.join(tools, "README.md"), "old\n");
    const metadata = NodePath.join(tools, ".git");
    await NodeFSP.chmod(metadata, 0o400);
    try {
      const directoryHandle = await NodeFSP.open(metadata, "r");
      expect((await directoryHandle.stat()).isDirectory()).toBe(true);
      await directoryHandle.close();
      await expect(NodeFSP.realpath(NodePath.join(metadata, "config"))).rejects.toMatchObject({
        code: "EACCES",
      });
      const verdict = await check(tools, "README.md");
      await NodeFSP.writeFile(
        NodePath.join(tools, "README.md"),
        "edited while metadata is unreadable\n",
      );
      expect(verdict.allowed).toBe(false);
    } finally {
      await NodeFSP.chmod(metadata, 0o755);
    }
  });

  it("allows a write inside an unprotected checkout", async () => {
    const { app } = await makeMachine();
    expect(await check(app, "src/main.ts")).toEqual({ allowed: true, unresolvedTarget: false });
    expect(await check(app, "src/new/file.ts")).toEqual({ allowed: true, unresolvedTarget: true });
  });

  it("refuses a write into a protected checkout", async () => {
    const { tools } = await makeMachine();
    expect(await check(tools, "README.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      realPath: NodePath.join(tools, "README.md"),
      checkoutRoot: tools,
      repository: "github.com/owner/tools",
      current: null,
    });
  });

  it("refuses a write through a file link into a protected checkout and keeps its current text", async () => {
    const { app, tools } = await makeMachine();
    expect(await check(app, "CLAUDE.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      target: NodePath.join(app, "CLAUDE.md"),
      realPath: NodePath.join(tools, "context", "projects", "app", "AGENTS.md"),
      checkoutRoot: tools,
      current: { contents: "# app\nold\n", truncated: false },
    });
  });

  it("refuses a new file through a directory link into a protected checkout", async () => {
    const { app, tools } = await makeMachine();
    expect(await check(app, "context/supplement/notes.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      realPath: NodePath.join(tools, "context", "projects", "app", "supplement", "notes.md"),
      checkoutRoot: tools,
    });
  });

  it("refuses a write in a worktree of a protected repository", async () => {
    const { worktree } = await makeMachine();
    expect(await check(worktree, "docs/plan.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      checkoutRoot: worktree,
      repository: "github.com/owner/tools",
    });
  });

  it("refuses a write when the workspace itself is a link into a protected checkout", async () => {
    const { toolsLink, tools } = await makeMachine();
    expect(await check(toolsLink, "context/projects/app/AGENTS.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      realPath: NodePath.join(tools, "context", "projects", "app", "AGENTS.md"),
    });
  });

  it("matches the protected repository however its remote is spelt", async () => {
    const { tools } = await makeMachine();
    for (const spelling of [
      "https://github.com/Owner/Tools.git",
      "git@github.com:owner/tools",
      "ssh://git@github.com/owner/tools.git",
      "git+ssh://git@github.com/owner/tools.git",
      "github.com:owner/tools.git",
    ]) {
      expect(await check(tools, "README.md", [spelling])).toMatchObject({ allowed: false });
    }
  });

  it("allows the same link when its repository is not protected", async () => {
    const { app } = await makeMachine();
    expect(await check(app, "CLAUDE.md", ["github.com/owner/other"])).toEqual({
      allowed: true,
      unresolvedTarget: false,
    });
  });

  it("is not fooled by a stray or nested .git inside a protected checkout", async () => {
    const { tools } = await makeMachine();
    await NodeFSP.mkdir(NodePath.join(tools, "vendor", ".git"), { recursive: true });
    await write(NodePath.join(tools, "loose", ".git"), "not a gitdir pointer\n");
    await write(
      NodePath.join(tools, "nested", ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/owner/other.git\n',
    );
    expect(await check(tools, "vendor/lib.md")).toMatchObject({
      allowed: false,
      reason: "unverified",
    });
    for (const path of ["loose/notes.md", "nested/readme.md"]) {
      expect(await check(tools, path)).toMatchObject({
        allowed: false,
        reason: "protected",
        checkoutRoot: tools,
      });
    }
  });

  it("flags a dangling link it cannot follow, and refuses once the write has made it real", async () => {
    const { app, tools } = await makeMachine();
    const missing = NodePath.join(tools, "context", "projects", "app", "NOTES.md");
    await NodeFSP.symlink(missing, NodePath.join(app, "NOTES.md"));
    expect(await check(app, "NOTES.md")).toEqual({ allowed: true, unresolvedTarget: true });
    // The stock server's write follows the dangling link and creates its target.
    await NodeFSP.writeFile(NodePath.join(app, "NOTES.md"), "written\n");
    expect(await check(app, "NOTES.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      realPath: missing,
    });
  });

  it("follows a file link to wherever it leads, even inside the workspace", async () => {
    const { root, app, tools } = await makeMachine();
    // A home-rooted project: its config links into the protected checkout.
    await write(
      NodePath.join(root, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:owner/home.git\n',
    );
    await NodeFSP.mkdir(NodePath.join(root, "config"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(tools, "context", "projects", "app", "AGENTS.md"),
      NodePath.join(root, "config", "unit.service"),
    );
    expect(await check(root, "config/unit.service")).toMatchObject({
      allowed: false,
      reason: "protected",
      realPath: NodePath.join(tools, "context", "projects", "app", "AGENTS.md"),
    });
    // An anchored read confirms a link stays inside its own directory.
    await NodeFSP.symlink(NodePath.join("src", "main.ts"), NodePath.join(app, "MAIN.ts"));
    expect(await check(app, "MAIN.ts")).toEqual({ allowed: true, unresolvedTarget: false });
    await NodeFSP.symlink("main.ts", NodePath.join(app, "src", "SAME.ts"));
    expect(await check(app, "src/SAME.ts")).toEqual({ allowed: true, unresolvedTarget: false });
  });

  it("counts every remote, so a fork with the protected repository as upstream is protected", async () => {
    const { root } = await makeMachine();
    const fork = NodePath.join(root, "fork");
    await write(
      NodePath.join(fork, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:someone/tools.git\n[remote "upstream"]\n\turl = https://github.com/owner/tools\n',
    );
    expect(await check(fork, "notes.md")).toMatchObject({
      allowed: false,
      reason: "protected",
      checkoutRoot: fork,
      repository: "github.com/owner/tools",
    });
  });

  it("refuses rather than probe a path the server would trim into another", async () => {
    const { root, tools } = await makeMachine();
    // A home-rooted project that contains the protected checkout.
    await write(
      NodePath.join(root, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:owner/home.git\n',
    );
    await NodeFSP.mkdir(NodePath.join(root, "d "), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(tools, "context", "projects", "app", "AGENTS.md"),
      NodePath.join(root, "d ", "x.md"),
    );
    await write(NodePath.join(root, "d", "x.md"), "decoy\n");
    expect(await check(root, "d /x.md")).toMatchObject({ allowed: false, reason: "unverified" });
  });

  it("refuses when the destination cannot be verified", async () => {
    const { app } = await makeMachine();
    const verdict = await checkProjectWrite(
      { cwd: app, relativePath: "src/main.ts" },
      {
        protectedRepositories: protectedTools,
        probe: {
          read: async () => ({ kind: "failed", detail: "environment unavailable" }),
          listFiles: async () => ({ kind: "failed", detail: "environment unavailable" }),
        },
      },
    );
    expect(verdict).toEqual({
      allowed: false,
      reason: "unverified",
      target: NodePath.join(app, "src", "main.ts"),
      detail: "environment unavailable",
    });
  });

  it("refuses when a probe of the server fails outright", async () => {
    const { app } = await makeMachine();
    const verdict = await checkProjectWrite(
      { cwd: app, relativePath: "src/main.ts" },
      {
        protectedRepositories: protectedTools,
        probe: {
          read: () => Promise.reject(new Error("socket closed")),
          listFiles: () => Promise.reject(new Error("socket closed")),
        },
      },
    );
    expect(verdict).toMatchObject({ allowed: false, reason: "unverified" });
  });

  it("leaves a write outside the workspace to the server, which refuses it", async () => {
    const { app } = await makeMachine();
    expect(await check(app, "../tools/README.md")).toEqual({
      allowed: true,
      unresolvedTarget: false,
    });
  });
});

it.each([
  ["EACCES", "failed"],
  ["ELOOP", "failed"],
  ["unknown", "failed"],
  ["ENOENT", "missing"],
  ["ENOTDIR", "missing"],
])("classifies a serialized %s resolution failure as %s", (code, kind) => {
  expect(
    classifyReadFailure({
      _tag: "ProjectReadFileError",
      failure: "operation_failed",
      operation: "realpath-target",
      cause: new Error("workspace operation failed", {
        cause: new Error(`${code}: realpath failed`),
      }),
    }).kind,
  ).toBe(kind);
});

it("refuses discovered Git metadata whose config is missing", async () => {
  const { tools } = await makeMachine();
  await NodeFSP.unlink(NodePath.join(tools, ".git", "config"));
  expect(await check(tools, "README.md")).toMatchObject({ allowed: false, reason: "unverified" });
});

describe("attempted change", () => {
  it("shows an edit as a unified diff with context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n") + "\n";
    expect(formatAttemptedChange("/x/notes.md", { contents: before, truncated: false }, after))
      .toBe(`--- /x/notes.md
+++ /x/notes.md
@@ -2,7 +2,7 @@
 b
 c
 d
-e
+E
 f
 g
 h`);
  });

  it("shows a new file as all additions", () => {
    expect(formatAttemptedChange("/x/new.md", null, "one\ntwo\n")).toBe(`--- /dev/null
+++ /x/new.md
@@ -0,0 +1,2 @@
+one
+two`);
  });

  it("says when nothing would change", () => {
    expect(formatAttemptedChange("/x/a", { contents: "same\n", truncated: false }, "same\n")).toBe(
      "/x/a: no change, the file already has these contents.",
    );
  });

  it("falls back to the attempted contents when the current file was too large to read whole", () => {
    expect(formatAttemptedChange("/x/big", { contents: "partial", truncated: true }, "new\n")).toBe(
      "/x/big is too large to compare; the attempted contents were:\nnew",
    );
  });
});
