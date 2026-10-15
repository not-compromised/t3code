import { normalizeGitRemoteUrl, parseOriginUrlFromGitConfig } from "@t3tools/shared/git";

/**
 * What a server's `projects.readFile` says about one path. It is the only
 * probe used: stock servers answer it, and its errors carry the real path
 * behind links, which lets the client see where a write would land without
 * any new server code.
 */
export type GuardRead =
  | { readonly kind: "file"; readonly contents: string; readonly truncated: boolean }
  | { readonly kind: "directory"; readonly realPath: string }
  | { readonly kind: "binary"; readonly realPath: string }
  /** A workspace-relative path whose real target is outside the workspace. */
  | { readonly kind: "escapes"; readonly realPath: string }
  /**
   * realpath failed. Stock servers expose no lstat, so a link whose target
   * does not exist yet reads exactly like a file that does not exist.
   */
  | { readonly kind: "missing" }
  /** Refused lexically by the server; a write there is refused the same way. */
  | { readonly kind: "outside-workspace" }
  | { readonly kind: "failed"; readonly detail: string };

/** Maps a `projects.readFile` failure, as decoded from the wire, to what it says about the path. */
export function classifyReadFailure(error: unknown): GuardRead {
  const failure = error as {
    readonly _tag?: unknown;
    readonly failure?: unknown;
    readonly operation?: unknown;
    readonly resolvedPath?: unknown;
    readonly message?: unknown;
  };
  const detail = typeof failure?.message === "string" ? failure.message : String(error);
  if (failure?._tag !== "ProjectReadFileError") return { kind: "failed", detail };
  const realPath = typeof failure.resolvedPath === "string" ? failure.resolvedPath : null;
  switch (failure.failure) {
    case "resolved_path_outside_root":
      return realPath === null ? { kind: "failed", detail } : { kind: "escapes", realPath };
    case "path_not_file":
      return realPath === null ? { kind: "failed", detail } : { kind: "directory", realPath };
    case "binary_file":
      return realPath === null ? { kind: "failed", detail } : { kind: "binary", realPath };
    case "workspace_path_outside_root":
      return { kind: "outside-workspace" };
    case "operation_failed":
      if (
        failure.operation === "realpath-target" ||
        failure.operation === "realpath-workspace-root"
      ) {
        let cause: unknown = error;
        for (let depth = 0; cause != null && depth < 8; depth++) {
          const nested = cause as { code?: unknown; message?: unknown; cause?: unknown };
          if (
            nested.code === "ENOENT" ||
            nested.code === "ENOTDIR" ||
            (typeof nested.message === "string" && /^(ENOENT|ENOTDIR):/.test(nested.message))
          ) {
            return { kind: "missing" };
          }
          cause = nested.cause;
        }
      }
      return { kind: "failed", detail };
    default:
      return { kind: "failed", detail };
  }
}

/** The two stock requests the guard asks a server, both as the desktop app sends them. */
export interface GuardProbe {
  /** `projects.readFile`: `path` is relative to `cwd` (the write's workspace by default) or absolute. */
  readonly read: (path: string, cwd?: string) => Promise<GuardRead>;
  /**
   * `projects.listEntries` for one workspace directory: the names of its
   * regular files. Links are never listed, which is how a link is told apart.
   */
  readonly listFiles: (
    directoryPath: string,
  ) => Promise<
    | { readonly kind: "listed"; readonly files: ReadonlyArray<string> }
    | { readonly kind: "failed"; readonly detail: string }
  >;
}

export interface ProjectWriteTarget {
  readonly cwd: string;
  readonly relativePath: string;
}

export type ProjectWriteVerdict =
  | {
      readonly allowed: true;
      /**
       * The target did not exist, so a dangling link there could not be
       * followed: the write is allowed and must be checked again once made.
       */
      readonly unresolvedTarget: boolean;
    }
  | {
      readonly allowed: false;
      readonly reason: "protected";
      readonly target: string;
      readonly realPath: string;
      readonly checkoutRoot: string;
      readonly repository: string;
      /** The file as it is now; null when it does not exist or cannot be read. */
      readonly current: { readonly contents: string; readonly truncated: boolean } | null;
    }
  | {
      readonly allowed: false;
      readonly reason: "unverified";
      readonly target: string;
      readonly detail: string;
    };

class Unverified {
  constructor(readonly detail: string) {}
}

/** `github.com/owner/repo` for any spelling of that repository's remote URL. */
export function normalizeRepositoryKey(value: string): string {
  const url = value
    .trim()
    .replace(/^git\+ssh:\/\//i, "ssh://")
    // scp-style without a user, which the shared normalizer leaves alone.
    .replace(/^([^@/:\s]+\.[^@/:\s]+):(?!\/\/)/, "git@$1:");
  return normalizeGitRemoteUrl(url);
}

/** A setting must name a repository as host/owner/repo; anything else protects nothing. */
export function isRepositoryKey(key: string): boolean {
  return /^[^/\s]+\.[^/\s]+(\/[^/\s]+){2,}$/.test(key);
}

/** Every remote's URL in a git config, each read with the shared value parser. */
function remoteUrls(configText: string): string[] {
  const header = /^[ \t]*\[\s*remote(?:\s+"[^"]+"|\.[^\]\s]+)\s*\]/gim;
  const starts = [...configText.matchAll(header)].map((match) => match.index ?? 0);
  return starts.flatMap((start, index) => {
    const url = parseOriginUrlFromGitConfig(configText.slice(start, starts[index + 1]));
    return url === null ? [] : [url];
  });
}

function normalizePosix(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function joinPosix(base: string, child: string): string {
  return normalizePosix(child.startsWith("/") ? child : `${base}/${child}`);
}

function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function basenamePosix(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isInside(root: string, path: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/**
 * Decides whether a `projects.writeFile` may proceed: refused when the real
 * destination, after every link, lies inside any checkout whose primary remote
 * is a protected repository, or when that cannot be established (a file link
 * into its own directory's subtree is one such case). The one link it cannot
 * see is a dangling one at the target itself (see `GuardRead`), so such a
 * write comes back flagged for a check once it exists. POSIX servers only.
 */
export async function checkProjectWrite(
  target: ProjectWriteTarget,
  options: {
    readonly protectedRepositories: ReadonlyArray<string>;
    readonly probe: GuardProbe;
  },
): Promise<ProjectWriteVerdict> {
  const cwd = target.cwd.trim();
  const relativePath = target.relativePath.trim();
  const display = joinPosix(cwd, relativePath);
  if (!cwd.startsWith("/")) {
    return {
      allowed: false,
      reason: "unverified",
      target: `${cwd}/${relativePath}`,
      detail: "the workspace path is not a POSIX absolute path",
    };
  }
  const workspace = normalizePosix(cwd);
  if (relativePath.startsWith("/") || !isInside(workspace, display) || display === workspace) {
    // The server refuses a write outside the workspace by itself.
    return { allowed: true, unresolvedTarget: false };
  }

  const protectedKeys = new Set(options.protectedRepositories.map(normalizeRepositoryKey));
  const reads = new Map<string, Promise<GuardRead>>();
  // The server trims every path it is sent, so a path ending in whitespace
  // would be answered for a different file.
  const untrimmed = (...values: ReadonlyArray<string | undefined>) =>
    values.some((value) => value !== undefined && value !== value.trim());
  const read = (path: string, cwd?: string): Promise<GuardRead> => {
    if (untrimmed(path, cwd)) {
      return Promise.resolve({ kind: "failed", detail: `${path} ends in whitespace` });
    }
    const key = JSON.stringify([cwd ?? null, path]);
    let pending = reads.get(key);
    if (pending === undefined) {
      pending = options.probe
        .read(path, cwd)
        .catch((cause: unknown): GuardRead => ({ kind: "failed", detail: String(cause) }));
      reads.set(key, pending);
    }
    return pending;
  };

  const realDirectory = async (directory: string): Promise<string> => {
    if (directory === "/") return "/";
    const result = await read(directory);
    switch (result.kind) {
      case "directory":
      case "binary":
      case "escapes":
        return result.realPath;
      case "file":
        // A file where a directory belongs: the server's write fails there.
        return directory;
      case "missing":
        return joinPosix(await realDirectory(dirnamePosix(directory)), basenamePosix(directory));
      case "outside-workspace":
        throw new Unverified(`the server would not resolve ${directory}`);
      case "failed":
        throw new Unverified(result.detail);
    }
  };

  const destination = async (): Promise<{ readonly realPath: string; readonly found: boolean }> => {
    const result = await read(relativePath);
    switch (result.kind) {
      case "escapes":
      case "directory":
      case "binary":
        return { realPath: result.realPath, found: true };
      case "missing":
        return {
          realPath: joinPosix(await realDirectory(dirnamePosix(display)), basenamePosix(display)),
          found: false,
        };
      case "file": {
        const name = basenamePosix(display);
        const parent = await realDirectory(dirnamePosix(display));
        const inWorkspace = display.slice(workspace === "/" ? 1 : workspace.length + 1);
        const directoryPath = inWorkspace.includes("/")
          ? dirnamePosix(`/${inWorkspace}`).slice(1)
          : "";
        if (untrimmed(directoryPath)) throw new Unverified(`${directoryPath} ends in whitespace`);
        const listing = await options.probe
          .listFiles(directoryPath)
          .catch((cause: unknown) => ({ kind: "failed" as const, detail: String(cause) }));
        if (listing.kind === "failed") throw new Unverified(listing.detail);
        if (listing.files.includes(name)) return { realPath: joinPosix(parent, name), found: true };
        // A link to a file elsewhere in the workspace. Anchored at its own
        // directory, the read escapes and reports where the link leads.
        const anchored = await read(name, parent);
        if (anchored.kind === "escapes") return { realPath: anchored.realPath, found: true };
        if (anchored.kind === "file") return { realPath: joinPosix(parent, name), found: true };
        throw new Unverified(`${display} is a link and the server does not say where it leads`);
      }
      case "outside-workspace":
        throw new Unverified(`the server would not resolve ${relativePath}`);
      case "failed":
        throw new Unverified(result.detail);
    }
  };

  const gitConfigPath = async (directory: string, dotGit: GuardRead): Promise<string | null> => {
    if (dotGit.kind === "directory") return joinPosix(dotGit.realPath, "config");
    if (dotGit.kind !== "file") throw new Unverified(`unexpected ${directory}/.git`);
    const pointer = /^gitdir:\s*(.+)$/m.exec(dotGit.contents)?.[1]?.trim();
    if (!pointer) return null;
    const gitDir = joinPosix(directory, pointer);
    const commonDir = await read(joinPosix(gitDir, "commondir"));
    if (commonDir.kind === "file") {
      return joinPosix(joinPosix(gitDir, commonDir.contents.trim()), "config");
    }
    if (commonDir.kind === "missing") return joinPosix(gitDir, "config");
    throw new Unverified(
      commonDir.kind === "failed" ? commonDir.detail : `unexpected ${gitDir}/commondir`,
    );
  };

  // Any remote counts: a fork cloned with the protected repository as its
  // upstream holds the same files.
  const repositoriesOf = async (directory: string, dotGit: GuardRead): Promise<string[]> => {
    const configPath = await gitConfigPath(directory, dotGit);
    if (configPath === null) return [];
    const config = await read(configPath);
    if (config.kind !== "file") {
      throw new Unverified(config.kind === "failed" ? config.detail : `unreadable ${configPath}`);
    }
    return remoteUrls(config.contents).map(normalizeRepositoryKey);
  };

  // Every enclosing checkout counts, not only the nearest: a stray or nested
  // `.git` inside a protected checkout must not hide it.
  const protectedCheckout = async (
    realPath: string,
  ): Promise<{ readonly root: string; readonly repository: string } | null> => {
    for (let directory = dirnamePosix(realPath); ; directory = dirnamePosix(directory)) {
      const dotGit = await read(joinPosix(directory, ".git"));
      if (dotGit.kind === "failed") throw new Unverified(dotGit.detail);
      if (dotGit.kind !== "missing") {
        const repository = (await repositoriesOf(directory, dotGit)).find((key) =>
          protectedKeys.has(key),
        );
        if (repository !== undefined) return { root: directory, repository };
      }
      if (directory === "/") return null;
    }
  };

  try {
    const { realPath, found } = await destination();
    const checkout = await protectedCheckout(realPath);
    if (checkout === null) return { allowed: true, unresolvedTarget: !found };
    const now = await read(realPath);
    return {
      allowed: false,
      reason: "protected",
      target: display,
      realPath,
      checkoutRoot: checkout.root,
      repository: checkout.repository,
      current: now.kind === "file" ? { contents: now.contents, truncated: now.truncated } : null,
    };
  } catch (error) {
    if (!(error instanceof Unverified)) throw error;
    return { allowed: false, reason: "unverified", target: display, detail: error.detail };
  }
}

const MAX_CHANGE_LINES = 400;
const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The attempted change as one unified-diff hunk spanning every edited line,
 * so the refusal keeps what was going to be written.
 */
export function formatAttemptedChange(
  path: string,
  current: { readonly contents: string; readonly truncated: boolean } | null,
  attempted: string,
): string {
  const attemptedLines = splitLines(attempted);
  const cap = (lines: string[]) =>
    lines.length <= MAX_CHANGE_LINES
      ? lines
      : [...lines.slice(0, MAX_CHANGE_LINES), `… ${lines.length - MAX_CHANGE_LINES} more lines`];
  if (current?.truncated) {
    return [
      `${path} is too large to compare; the attempted contents were:`,
      ...cap(attemptedLines),
    ].join("\n");
  }
  const before = current === null ? [] : splitLines(current.contents);
  let start = 0;
  while (
    start < before.length &&
    start < attemptedLines.length &&
    before[start] === attemptedLines[start]
  ) {
    start += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = attemptedLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === attemptedLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  if (start === beforeEnd && start === afterEnd) {
    return current !== null && current.contents === attempted
      ? `${path}: no change, the file already has these contents.`
      : `${path}: only the final newline differs.`;
  }
  const from = Math.max(0, start - CONTEXT_LINES);
  const trailing = Math.min(CONTEXT_LINES, before.length - beforeEnd);
  const range = (first: number, count: number) =>
    count === 0 ? `${first},0` : `${first + 1},${count}`;
  return [
    `--- ${current === null ? "/dev/null" : path}`,
    `+++ ${path}`,
    `@@ -${range(from, beforeEnd + trailing - from)} +${range(from, afterEnd + trailing - from)} @@`,
    ...cap([
      ...before.slice(from, start).map((line) => ` ${line}`),
      ...before.slice(start, beforeEnd).map((line) => `-${line}`),
      ...attemptedLines.slice(start, afterEnd).map((line) => `+${line}`),
      ...before.slice(beforeEnd, beforeEnd + trailing).map((line) => ` ${line}`),
    ]),
  ].join("\n");
}
