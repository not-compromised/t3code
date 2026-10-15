// @effect-diagnostics nodeBuiltinImport:off -- A FIFO-safe read needs descriptor flags unavailable in FileSystem.
import * as NodeFS from "node:fs";

import type { DesktopWriteGuardState } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/**
 * The guard is on exactly while this file exists in the desktop's state
 * directory. The machine's own tooling writes and removes it; the app never
 * does, so switching the guard needs no restart and no settings UI.
 */
export const WRITE_GUARD_SETTINGS_FILE = "write-guard.json";
const MAX_SETTINGS_BYTES = 16 * 1024;

const WriteGuardSettings = Schema.Struct({
  protectedRepositories: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});
// A misspelt key must not read as "no repositories", which would be a silent off.
const decodeSettings = Schema.decodeUnknownExit(Schema.fromJsonString(WriteGuardSettings), {
  onExcessProperty: "error",
});

type SettingsRead =
  | { readonly kind: "missing" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unreadable"; readonly problem: string };

function readSettingsFile(filePath: string): SettingsRead {
  let fd: number;
  try {
    // O_NONBLOCK keeps a FIFO from hanging the open; symlinks are followed so
    // the file may be linked from the tooling that manages it.
    fd = NodeFS.openSync(filePath, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      return { kind: "unreadable", problem: `cannot open it (${String(cause)})` };
    }
    // A link whose managed file moved must not read as the guard switched off.
    try {
      NodeFS.lstatSync(filePath);
      return { kind: "unreadable", problem: "it is a link to a file that does not exist" };
    } catch {
      return { kind: "missing" };
    }
  }
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile()) return { kind: "unreadable", problem: "it is not a regular file" };
    if (info.size > MAX_SETTINGS_BYTES) {
      return { kind: "unreadable", problem: `it is larger than ${MAX_SETTINGS_BYTES} bytes` };
    }
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { kind: "text", text: contents.subarray(0, offset).toString("utf8") };
  } catch (cause) {
    return { kind: "unreadable", problem: `cannot read it (${String(cause)})` };
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Reads the guard's state on every call, so the tooling's switch takes effect
 * on the next write. A present file that cannot be used reports "invalid",
 * which the renderer treats as on and refusing everything: a broken switch
 * fails closed and visibly rather than silently turning the guard off.
 */
export function readWriteGuardState(settingsPath: string): DesktopWriteGuardState {
  const read = readSettingsFile(settingsPath);
  if (read.kind === "missing") {
    return { status: "off", settingsPath, protectedRepositories: [], problem: null };
  }
  if (read.kind === "unreadable") {
    return { status: "invalid", settingsPath, protectedRepositories: [], problem: read.problem };
  }
  const decoded = decodeSettings(read.text);
  const repositories = Exit.isSuccess(decoded)
    ? decoded.value.protectedRepositories.map((entry) => entry.trim())
    : [];
  if (repositories.length === 0 || repositories.some((entry) => entry.length === 0)) {
    return {
      status: "invalid",
      settingsPath,
      protectedRepositories: [],
      problem:
        'it must be JSON of the form {"protectedRepositories": ["<repository>", ...]} naming at least one repository',
    };
  }
  return { status: "on", settingsPath, protectedRepositories: repositories, problem: null };
}
