/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertDisposableTestDatabase,
  readTestDatabaseUrl,
  TestDatabaseGuardError,
} from "./test-database.js";

describe("disposable test database guard", () => {
  test("accepts a local _test URL", () => {
    const result = assertDisposableTestDatabase(
      "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
    );
    assert.equal(result.host, "localhost");
    assert.equal(result.port, 5433);
    assert.equal(result.database, "soundhub_m1_test");
  });

  test("rejects a URL whose database name does not end in _test", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase("postgresql://soundhub:password@localhost:5432/soundhub_db"),
      (err: unknown) => err instanceof TestDatabaseGuardError,
    );
  });

  test("rejects a non-local host", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@db.example.com:5432/soundhub_m1_test",
        ),
      (err: unknown) => err instanceof TestDatabaseGuardError,
    );
  });

  test("rejects a non-postgres scheme", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase("mysql://soundhub:password@localhost:3306/soundhub_m1_test"),
      (err: unknown) => err instanceof TestDatabaseGuardError,
    );
  });

  test("rejects a missing URL", () => {
    const saved = process.env.TEST_DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    try {
      assert.throws(
        () => readTestDatabaseUrl(),
        (err: unknown) => err instanceof TestDatabaseGuardError,
      );
    } finally {
      if (saved !== undefined) process.env.TEST_DATABASE_URL = saved;
    }
  });
});
