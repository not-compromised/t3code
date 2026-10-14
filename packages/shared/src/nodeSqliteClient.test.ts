// @effect-diagnostics nodeBuiltinImport:off -- native HTTP probes test event-loop responsiveness during SQLite contention.
import * as NodeSqlite from "node:sqlite";
import * as NodeHttp from "node:http";
import * as NodeBuffer from "node:buffer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect.each(["statement", "reservation", "transaction"] as const)(
    "keeps the connection usable after cancelling a %s at a scheduler yield",
    (kind) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const operation =
          kind === "reservation"
            ? Effect.scoped(Effect.andThen(sql.reserve, Effect.never))
            : kind === "transaction"
              ? sql.withTransaction(sql`SELECT 1`)
              : sql`SELECT 1`;
        for (let prefix = 0; prefix < 12; prefix++) {
          for (let step = 0; step < 12; step++) {
            const fiber = yield* Effect.gen(function* () {
              // Shift scheduler yields across acquisition and finalizer registration.
              for (let index = 0; index < prefix; index++) yield* Effect.sync(() => index);
              yield* operation;
            }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8), Effect.forkChild);
            for (let index = 0; index < step; index++) yield* Effect.yieldNow;
            yield* Fiber.interrupt(fiber);
            assert.deepEqual(yield* sql`SELECT 1 AS usable`.values, [[1]]);
          }
        }
      }),
  );

  it.effect.each(["statement", "reservation"] as const)(
    "can cancel a waiting %s while another caller holds the connection",
    (kind) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const lease = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        yield* Scope.provide(sql.reserve, lease);
        const operation =
          kind === "reservation"
            ? Effect.scoped(Effect.andThen(sql.reserve, Effect.never))
            : sql`SELECT 1`;
        const waiter = yield* operation.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(waiter);
        assert(Exit.hasInterrupts(yield* Fiber.await(waiter)));
        yield* Scope.close(lease, Exit.void);
        assert.deepEqual(yield* sql`SELECT 1 AS usable`.values, [[1]]);
      }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );

  it.effect("preserves raw write results, blobs, and safe integers across result modes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE typed_values(id INTEGER PRIMARY KEY, big INTEGER, bytes BLOB)`;
      const result =
        yield* sql`INSERT INTO typed_values(big, bytes) VALUES (${9007199254740993n}, ${new Uint8Array([0, 255])})`
          .raw;
      assert.deepEqual(result, { changes: 1, lastInsertRowid: 1 });
      const read = sql`SELECT big, bytes FROM typed_values`;
      const rows = yield* read.pipe(Effect.provideService(SqlClient.SafeIntegers, true));
      assert.deepEqual(rows, [{ big: 9007199254740993n, bytes: new Uint8Array([0, 255]) }]);
      assert.deepEqual(
        yield* read.values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
        [[9007199254740993n, new Uint8Array([0, 255])]],
      );
      // The next caller's integer mode must not inherit the previous caller's.
      yield* sql`UPDATE typed_values SET big = 42`;
      assert.equal(typeof (yield* read)[0]?.big, "number");
    }),
  );

  it.effect("keeps an independent write outside a transaction that rolls back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE rollback_counter(value INTEGER)`;
      yield* sql`INSERT INTO rollback_counter VALUES (0)`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* Effect.forkChild(
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE rollback_counter SET value = 10`;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(entered);
      const independent = yield* Effect.forkChild(
        sql`UPDATE rollback_counter SET value = value + 1`,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      assert(Exit.isFailure(yield* Fiber.join(transaction)));
      yield* Fiber.join(independent);
      assert.deepEqual(yield* sql`SELECT value FROM rollback_counter`.values, [[1]]);
    }),
  );

  it.effect("stores empty binary parameters as BLOBs rather than SQL NULL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE empty_blobs(bytes BLOB NOT NULL)`;
      yield* sql`INSERT INTO empty_blobs VALUES (${new Uint8Array()})`;
      yield* sql`INSERT INTO empty_blobs VALUES (${NodeBuffer.Buffer.alloc(0)})`;
      assert.deepEqual(yield* sql`SELECT typeof(bytes), length(bytes) FROM empty_blobs`.values, [
        ["blob", 0],
        ["blob", 0],
      ]);
    }),
  );

  it.effect("rolls back an interrupted transaction before reusing its connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE interrupted_counter(value INTEGER)`;
      yield* sql`INSERT INTO interrupted_counter VALUES (0)`;
      const entered = yield* Deferred.make<void>();
      const transaction = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE interrupted_counter SET value = 10`;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(transaction);
      yield* sql`UPDATE interrupted_counter SET value = value + 1`;
      assert.deepEqual(yield* sql`SELECT value FROM interrupted_counter`.values, [[1]]);
    }),
  );
});

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect.each([
  { name: "write", interrupt: false },
  { name: "transaction cancellation", interrupt: true },
])("serves a connection heartbeat during a blocked SQLite $name", ({ interrupt }) =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve, reject) => {
            const server = NodeHttp.createServer((_request, response) => {
              other.exec("COMMIT");
              response.end("pong");
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die("Heartbeat server did not bind a TCP port");
    }

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 250`;
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const statement = sql`UPDATE counters SET value = 1 WHERE id = 1`;
      const write = yield* Effect.forkChild(interrupt ? sql.withTransaction(statement) : statement);
      yield* Effect.yieldNow;
      const interruption = interrupt ? yield* Effect.forkChild(Fiber.interrupt(write)) : undefined;
      yield* Effect.yieldNow;

      // Only handling the heartbeat releases the write lock. Blocking the
      // event loop makes the write time out before the heartbeat can arrive.
      const response = yield* Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            const request = NodeHttp.get(
              `http://127.0.0.1:${address.port}/heartbeat`,
              (response) => {
                response.setEncoding("utf8");
                let body = "";
                response.on("data", (chunk: string) => {
                  body += chunk;
                });
                response.once("error", reject);
                response.once("end", () => resolve(body));
              },
            );
            request.once("error", reject);
          }),
      );
      assert.equal(response, "pong");
      if (interruption) {
        yield* Fiber.join(interruption);
        assert(Exit.hasInterrupts(yield* Fiber.await(write)));
      } else {
        yield* Fiber.join(write);
      }
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [
        [interrupt ? 0 : 1],
      ]);
      yield* sql`UPDATE counters SET value = value + 1 WHERE id = 1`;
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [
        [interrupt ? 1 : 2],
      ]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the sequential worker usable after cancelling a database scan", () =>
  Effect.gen(function* () {
    const scan = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT 1`.values, [[1]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));
    for (let prefix = 0; prefix < 12; prefix++) {
      for (let step = 0; step < 12; step++) {
        const fiber = yield* Effect.gen(function* () {
          for (let index = 0; index < prefix; index++) yield* Effect.sync(() => index);
          yield* scan;
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8), Effect.forkChild);
        for (let index = 0; index < step; index++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        yield* scan;
      }
    }
  }).pipe(Effect.provide(SqliteClient.layerSequentialWorker)),
);

it.effect("isolates databases and access modes when a sequential scan reuses its worker", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    const second = `${filename}.second`;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`;
      yield* sql`INSERT INTO counters VALUES (1, 7)`;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: second })));

    const read = (filename: string, readonly: boolean) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql`SELECT value FROM counters WHERE id = 1`.values;
        const change = sql`UPDATE counters SET value = value + 1 WHERE id = 1`;
        if (readonly) {
          assert.equal((yield* change.pipe(Effect.flip))._tag, "SqlError");
        } else {
          yield* change;
        }
        return before;
      }).pipe(Effect.provide(SqliteClient.layer({ filename, readonly })));

    assert.deepEqual(yield* read(filename, true), [[0]]);
    assert.deepEqual(yield* read(second, false), [[7]]);
    const failed = yield* Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(
      Effect.scoped,
      Effect.flip,
    );
    assert.equal(failed.reason.operation, "open");
    assert.deepEqual(yield* read(second, true), [[8]]);
    assert.deepEqual(yield* read(filename, true), [[0]]);
  }).pipe(Effect.provide(Layer.mergeAll(SqliteClient.layerSequentialWorker, NodeServices.layer))),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
