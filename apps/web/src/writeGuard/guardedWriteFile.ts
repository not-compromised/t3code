import {
  type DesktopWriteGuardState,
  type EnvironmentId,
  type ProjectWriteFileInput,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type AtomCommand,
  type AtomCommandResult,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  checkProjectWrite,
  classifyReadFailure,
  formatAttemptedChange,
  type GuardProbe,
  isRepositoryKey,
  normalizeRepositoryKey,
  type GuardRead,
  type ProjectWriteVerdict,
} from "./protectedCheckouts";

export interface ProjectWriteRequest {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectWriteFileInput;
}

export interface WriteGuardRefusal {
  /** One notice per file, replaced in place while edits keep being refused. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

export class WriteGuardRefusedError extends Error {
  readonly _tag = "WriteGuardRefusedError";
}

export interface WriteGuardPorts {
  /** Null outside the desktop app, where the guard does not exist. */
  readonly getState: (() => Promise<DesktopWriteGuardState>) | null;
  readonly read: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input: { readonly cwd: string; readonly relativePath: string },
  ) => Promise<GuardRead>;
  readonly listFiles: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input: { readonly cwd: string; readonly directoryPath: string },
  ) => ReturnType<GuardProbe["listFiles"]>;
  readonly notify: (refusal: WriteGuardRefusal) => void;
  readonly now: () => number;
}

/** An allowed destination is re-checked after this long, so a new link is caught. */
const ALLOWED_VERDICT_TTL_MS = 10_000;

const readFileForGuard = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:projects:write-guard-read",
  tag: WS_METHODS.projectsReadFile,
});
const listEntriesForGuard = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:projects:write-guard-list",
  tag: WS_METHODS.projectsListEntries,
});

const defaultPorts: WriteGuardPorts = {
  getState: (() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    const getWriteGuard = bridge?.getWriteGuard;
    return bridge === undefined
      ? null
      : () => {
          if (!getWriteGuard) throw new Error("The desktop app has no getWriteGuard method");
          return getWriteGuard();
        };
  })(),
  read: async (registry, environmentId, input) => {
    const result = await readFileForGuard.run(registry, { environmentId, input });
    return result._tag === "Success"
      ? { kind: "file", contents: result.value.contents, truncated: result.value.truncated }
      : classifyReadFailure(Cause.squash(result.cause));
  },
  listFiles: async (registry, environmentId, input) => {
    const result = await listEntriesForGuard.run(registry, { environmentId, input });
    if (result._tag !== "Success") {
      const error = Cause.squash(result.cause) as { readonly message?: unknown };
      return {
        kind: "failed",
        detail: typeof error?.message === "string" ? error.message : String(error),
      };
    }
    if (
      result.value.entries.some(
        (entry) =>
          entry.path.startsWith("/") ||
          entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) !== input.directoryPath,
      )
    ) {
      return {
        kind: "failed",
        detail: "The server listed entries outside the requested directory",
      };
    }
    return {
      kind: "listed",
      files: result.value.entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1)),
    };
  },
  notify: (refusal) => {
    // Loaded on first refusal: the toast module reaches back into app state.
    void import("../components/ui/toast")
      .then(({ toastManager }) => {
        toastManager.add({
          id: `write-guard:${refusal.key}`,
          type: "error",
          title: refusal.title,
          description: refusal.description,
          timeout: 0,
        });
      })
      .catch((cause: unknown) => {
        console.error("The write guard could not show its notice.", cause);
      });
  },
  now: () => Date.now(),
};

type Refused = Exclude<ProjectWriteVerdict, { allowed: true }>;

function describeRefusal(
  request: ProjectWriteRequest,
  state: DesktopWriteGuardState,
  verdict: Refused | null,
): { readonly title: string; readonly summary: string; readonly body: string } {
  const { cwd, relativePath, contents } = request.input;
  const next = `Ask the owner to approve this change, or remove ${state.settingsPath} to switch the guard off.`;
  const tail = `The write guard is on, so T3 did not write it. ${next}`;
  if (verdict === null) {
    const target = `${cwd}/${relativePath}`;
    return {
      title: "Not saved: the write guard's settings are invalid",
      summary: `${state.settingsPath} is invalid: ${state.problem ?? "unreadable"}. Until it is fixed or removed, T3 writes no files. ${next}`,
      body: formatAttemptedChange(target, null, contents),
    };
  }
  if (verdict.reason === "unverified") {
    return {
      title: "Not saved: the write guard could not check this file",
      summary: `T3 could not confirm that ${verdict.target} is outside protected checkouts (${verdict.detail}). ${tail}`,
      body: formatAttemptedChange(verdict.target, null, contents),
    };
  }
  const where =
    verdict.realPath === verdict.target
      ? `${verdict.target} is`
      : `${verdict.target} leads to ${verdict.realPath},`;
  return {
    title: "Not saved: this file is in a protected checkout",
    summary: `${where} inside ${verdict.checkoutRoot}, a checkout of ${verdict.repository}. ${tail}`,
    body: formatAttemptedChange(verdict.realPath, verdict.current, contents),
  };
}

/**
 * Wraps `projects.writeFile` so that, while the desktop's write guard is on,
 * a write whose real destination is in a protected repository's checkout is
 * refused before anything reaches the server. With the guard off (or outside
 * the desktop app) every call goes to the wrapped command unchanged.
 */
export function guardWriteFile<A, E>(
  command: AtomCommand<ProjectWriteRequest, A, E>,
  ports: WriteGuardPorts = defaultPorts,
): AtomCommand<ProjectWriteRequest, A, E | WriteGuardRefusedError> {
  if (ports.getState === null) return command;
  const getState = ports.getState;
  // Checks take varying time; a per-file lane keeps writes in the order made.
  const lanes = new Map<string, Promise<unknown>>();
  const allowedUntil = new Map<string, number>();

  const guarded = async (
    registry: AtomRegistry.AtomRegistry,
    request: ProjectWriteRequest,
    key: string,
  ): Promise<AtomCommandResult<A, E | WriteGuardRefusedError>> => {
    let state: DesktopWriteGuardState;
    try {
      state = await getState();
    } catch (cause) {
      state = {
        status: "invalid",
        settingsPath: "the write guard's settings",
        protectedRepositories: [],
        problem: `the desktop app could not read them (${String(cause)})`,
      };
    }
    if (state.status === "off") {
      allowedUntil.clear();
      return command.run(registry, request);
    }
    const unusable = state.protectedRepositories.find(
      (entry) => !isRepositoryKey(normalizeRepositoryKey(entry)),
    );
    if (state.status === "on" && unusable !== undefined) {
      state = {
        ...state,
        status: "invalid",
        problem: `"${unusable}" does not name a repository the way github.com/owner/repo does`,
      };
    }

    let verdict: ProjectWriteVerdict | null = null;
    if (state.status === "on") {
      const cacheKey = JSON.stringify([key, state.protectedRepositories]);
      if ((allowedUntil.get(cacheKey) ?? 0) > ports.now()) return command.run(registry, request);
      const check = () =>
        checkProjectWrite(request.input, {
          protectedRepositories: state.protectedRepositories,
          probe: {
            read: (path, cwd = request.input.cwd) =>
              ports.read(registry, request.environmentId, { cwd, relativePath: path }),
            listFiles: (directoryPath) =>
              ports.listFiles(registry, request.environmentId, {
                cwd: request.input.cwd,
                directoryPath,
              }),
          },
        });
      verdict = await check();
      if (verdict.allowed && !verdict.unresolvedTarget) {
        const now = ports.now();
        for (const [entry, until] of allowedUntil) if (until <= now) allowedUntil.delete(entry);
        allowedUntil.set(cacheKey, now + ALLOWED_VERDICT_TTL_MS);
        return command.run(registry, request);
      }
      if (verdict.allowed) {
        const result = await command.run(registry, request);
        if (result._tag === "Success") {
          const landed = await check();
          if (!landed.allowed) {
            const unseen = `${landed.target} did not exist before this write, so the write guard could not see where a link there led.`;
            ports.notify({
              key,
              ...(landed.reason === "protected"
                ? {
                    title: "Saved into a protected checkout through a link",
                    description: `${unseen} T3 created ${landed.realPath} inside ${landed.checkoutRoot}, a checkout of ${landed.repository}; later writes to it are refused.\n\nChange made:\n${formatAttemptedChange(landed.realPath, null, request.input.contents)}`,
                  }
                : {
                    title: "Saved, but the write guard cannot tell where",
                    description: `${unseen} Now that it exists, the guard still cannot confirm it is outside protected checkouts (${landed.detail}); later writes to it are refused.\n\nChange made:\n${formatAttemptedChange(landed.target, null, request.input.contents)}`,
                  }),
            });
          }
        }
        return result;
      }
    }
    const refusal = describeRefusal(request, state, verdict);
    ports.notify({
      key,
      title: refusal.title,
      description: `${refusal.summary}\n\nAttempted change:\n${refusal.body}`,
    });
    return AsyncResult.failure(Cause.fail(new WriteGuardRefusedError(refusal.summary)));
  };

  return {
    label: command.label,
    run: (registry, request) => {
      const key = JSON.stringify([
        request.environmentId,
        request.input.cwd,
        request.input.relativePath,
      ]);
      const previous = lanes.get(key) ?? Promise.resolve();
      const current = previous.then(() => guarded(registry, request, key));
      const settled = current.then(
        () => undefined,
        () => undefined,
      );
      lanes.set(key, settled);
      void settled.then(() => {
        if (lanes.get(key) === settled) lanes.delete(key);
      });
      return current;
    },
  };
}
