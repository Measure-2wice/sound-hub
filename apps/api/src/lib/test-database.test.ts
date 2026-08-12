/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APPROVED_TEST_DATABASE_HOSTS,
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
  assertDisposableTestDatabase,
  readTestDatabaseUrl,
  TestDatabaseGuardError,
} from "./test-database.js";

describe("disposable test database guard", () => {
  test("accepts the approved local disposable test target", () => {
    const result = assertDisposableTestDatabase(
      "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
    );
    assert.equal(result.host, "localhost");
    assert.equal(result.port, 5433);
    assert.equal(result.database, "soundhub_m1_test");
  });

  test("accepts 127.0.0.1 as the local host", () => {
    const result = assertDisposableTestDatabase(
      "postgresql://soundhub:password@127.0.0.1:5433/soundhub_m1_test",
    );
    assert.equal(result.host, "127.0.0.1");
  });

  test("rejects 0.0.0.0 even though it was previously accepted", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@0.0.0.0:5433/soundhub_m1_test",
        ),
      (err: unknown) => err instanceof TestDatabaseGuardError,
    );
  });

  test("rejects a non-approved port (5432)", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@localhost:5432/soundhub_m1_test",
        ),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError && /port 5432 must be 5433/.test(err.message),
    );
  });

  test("rejects a non-approved database name even when it ends in _test", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@localhost:5433/some_other_test",
        ),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError && /some_other_test/.test(err.message),
    );
  });

  test("rejects a non-local host", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@db.example.com:5433/soundhub_m1_test",
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

  test("exports the exact approved target constants for callers", () => {
    assert.equal(APPROVED_TEST_DATABASE_NAME, "soundhub_m1_test");
    assert.equal(APPROVED_TEST_DATABASE_PORT, 5433);
    assert.ok(APPROVED_TEST_DATABASE_HOSTS.has("localhost"));
    assert.ok(APPROVED_TEST_DATABASE_HOSTS.has("127.0.0.1"));
    assert.ok(APPROVED_TEST_DATABASE_HOSTS.has("::1"));
    assert.equal(APPROVED_TEST_DATABASE_HOSTS.has("0.0.0.0"), false);
  });
});
