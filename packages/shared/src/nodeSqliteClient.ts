/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { ConnectionError, SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import {
  sqliteWorkerMain,
  type SqliteWorkerCommand,
  type SqliteWorkerOptions,
  type SqliteWorkerResponse,
} from "./nodeSqliteWorker.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

interface SqliteWorkerConnection {
  readonly request: <A>(command: SqliteWorkerCommand) => Effect.Effect<A, SqlError>;
}

class SequentialSqliteWorker extends Context.Service<
  SequentialSqliteWorker,
  {
    readonly reserve: Effect.Effect<SqliteWorkerConnection, SqlError, Scope.Scope>;
  }
>()("@t3tools/shared/nodeSqliteClient/SequentialSqliteWorker") {}

const takeScopedPermit = (semaphore: Semaphore.Semaphore) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      // Taking the permit and registering its release must be atomic with
      // respect to interruption. Waiting for an available permit must still
      // be interruptible, so wait with a temporary lease and retry the take.
      while (true) {
        if (yield* semaphore.takeIfAvailable(1)) {
          yield* Scope.addFinalizer(scope, semaphore.release(1));
          return;
        }
        yield* restore(semaphore.withPermits(1)(Effect.void));
      }
    }),
  );

const makeWorker = Effect.fnUntraced(function* (): Effect.fn.Return<
  SqliteWorkerConnection,
  SqlError,
  Scope.Scope
> {
  const scope = yield* Effect.scope;
  const worker = yield* Effect.try({
    try: () =>
      new NodeWorkerThreads.Worker(
        `(${sqliteWorkerMain.toString()})(require("node:sqlite"), require("node:worker_threads"))`,
        {
          eval: true,
        },
      ),
    catch: (cause) =>
      new SqlError({ reason: classifyError(cause, "Failed to open database", "open") }),
  });
  const pending = new Map<number, (result: Effect.Effect<unknown, SqlError>) => void>();
  let nextId = 0;
  let failure: SqlError | undefined;
  const fail = (cause: unknown) => {
    failure = new SqlError({
      reason: new ConnectionError({
        message: "SQLite worker stopped",
        operation: "execute",
        cause,
      }),
    });
    for (const resume of pending.values()) resume(Effect.fail(failure));
    pending.clear();
  };
  // "error" means the worker died on its own, for example out of memory. The
  // client cannot recover: the native connection and its PRAGMAs are gone.
  // Crash as a failure on the main thread did, so a supervisor restarts the
  // process instead of leaving it up with every query failing.
  worker.on("error", (cause) => {
    fail(cause);
    process.nextTick(() => {
      throw new Error("SQLite worker crashed", { cause });
    });
  });
  worker.on("exit", (code) => fail(new Error(`SQLite worker exited with code ${code}`)));
  worker.on("message", (response: SqliteWorkerResponse) => {
    const resume = pending.get(response.id);
    if (!resume) return;
    pending.delete(response.id);
    if (response.ok) {
      resume(Effect.succeed(response.value));
    } else {
      const cause = Object.assign(new Error(response.cause.message), response.cause);
      resume(
        Effect.fail(
          new SqlError({
            reason: classifyError(
              cause,
              {
                open: "Failed to open database",
                close: "Failed to close database",
                prepare: "Failed to prepare statement",
                execute: "Failed to execute statement",
              }[response.operation],
              response.operation,
            ),
          }),
        ),
      );
    }
  });

  // A cancelled caller must wait for its in-flight operation before rollback
  // or releasing the connection; terminating it could interrupt a durable commit.
  const request = <A>(command: SqliteWorkerCommand) =>
    Effect.callback<A, SqlError>((resume) => {
      if (failure) {
        // A dead worker has already closed its native database. Cleanup must
        // preserve the typed operation failure instead of adding a defect.
        resume(
          command.operation === "close" ? Effect.succeed(undefined as A) : Effect.fail(failure),
        );
        return;
      }
      const id = ++nextId;
      pending.set(id, (result) => resume(result as Effect.Effect<A, SqlError>));
      try {
        worker.postMessage({ ...command, id }, []);
      } catch (cause) {
        pending.delete(id);
        resume(
          Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to send database operation", command.operation),
            }),
          ),
        );
      }
    }).pipe(Effect.uninterruptible);

  yield* Scope.addFinalizer(
    scope,
    Effect.promise(() => worker.terminate()),
  );
  return { request };
});

// Sequential scanners lease the worker until each client's scope closes. The
// first uncached database starts it; cached scans never start a worker.
export const layerSequentialWorker = Layer.effect(
  SequentialSqliteWorker,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const semaphore = yield* Semaphore.make(1);
    const getWorker = yield* Effect.cached(Scope.provide(makeWorker(), scope));
    return SequentialSqliteWorker.of({
      reserve: Effect.uninterruptibleMask((restore) =>
        Effect.andThen(restore(takeScopedPermit(semaphore)), getWorker),
      ),
    });
  }),
);

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sharedWorker = yield* Effect.serviceOption(SequentialSqliteWorker);
    const { request } = yield* Option.isSome(sharedWorker)
      ? sharedWorker.value.reserve
      : makeWorker();
    yield* Scope.addFinalizer(scope, request<void>({ operation: "close" }).pipe(Effect.orDie));
    yield* request<void>({
      operation: "open",
      options: {
        filename: options.filename,
        readonly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
        prepareCacheTTL: Duration.toMillis(options.prepareCacheTTL ?? Duration.minutes(10)),
      } satisfies SqliteWorkerOptions,
    });

    const run = <A>(
      sql: string,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "values" | "raw",
      unprepared = false,
    ) =>
      Effect.withFiber<A, SqlError>((fiber) =>
        request<A>({
          operation: "execute",
          sql,
          params,
          mode,
          unprepared,
          safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
        }),
      );
    const rows = (sql: string, params: ReadonlyArray<unknown>, unprepared = false) =>
      run<ReadonlyArray<Record<string, unknown>>>(sql, params, "rows", unprepared);
    const values = (sql: string, params: ReadonlyArray<unknown>, unprepared = false) =>
      run<ReadonlyArray<ReadonlyArray<unknown>>>(sql, params, "values", unprepared);

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = rows(sql, params);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return run<unknown>(sql, params, "raw");
      },
      executeValues(sql, params) {
        return values(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return values(sql, params ?? [], true);
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = rows(sql, params ?? [], true);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;

  const transactionAcquirer = Effect.as(takeScopedPermit(semaphore), connection);

  return yield* Client.make({
    acquirer: transactionAcquirer,
    borrower: (use) => semaphore.withPermits(1)(use(connection)),
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
