/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APPROVED_QA_DATABASE_NAME,
  APPROVED_QA_DATABASE_PORT,
  APPROVED_TEST_DATABASE_HOSTS,
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
  assertDisposableTestDatabase,
  assertNotQaDatabase,
  readQaDatabaseUrl,
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

describe("manual-QA isolation guard", () => {
  // The destructive test scripts must NEVER run against the manual-QA
  // database. The QA database shares the same Compose instance as
  // the test database but uses a different name (soundhub_qa). The
  // guard rejects URLs that target the QA database even when the
  // host/port/name otherwise look correct.

  test("rejects URLs that point at the QA database", () => {
    assert.throws(
      () =>
        assertDisposableTestDatabase("postgresql://soundhub:password@localhost:5433/soundhub_qa"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError &&
        /soundhub_qa/.test(err.message) &&
        /manual-QA target/.test(err.message),
    );
  });

  test("still accepts the destructive test database (QA guard does not regress)", () => {
    const result = assertDisposableTestDatabase(
      "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
    );
    assert.equal(result.database, "soundhub_m1_test");
  });

  test("assertNotQaDatabase refuses the QA URL by name", () => {
    assert.throws(
      () => assertNotQaDatabase("postgresql://soundhub:password@localhost:5433/soundhub_qa"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError &&
        /soundhub_qa/.test(err.message) &&
        /manual-QA target/.test(err.message),
    );
  });

  test("assertNotQaDatabase accepts the destructive test database", () => {
    assert.doesNotThrow(() =>
      assertNotQaDatabase("postgresql://soundhub:password@localhost:5433/soundhub_m1_test"),
    );
  });

  test("readQaDatabaseUrl honors QA_DATABASE_URL when set", () => {
    const expected = "postgresql://soundhub:password@localhost:5433/soundhub_qa";
    const saved = process.env.QA_DATABASE_URL;
    process.env.QA_DATABASE_URL = expected;
    try {
      assert.equal(readQaDatabaseUrl(), expected);
    } finally {
      if (saved === undefined) delete process.env.QA_DATABASE_URL;
      else process.env.QA_DATABASE_URL = saved;
    }
  });

  test("readQaDatabaseUrl falls back to the approved QA target", () => {
    const saved = process.env.QA_DATABASE_URL;
    delete process.env.QA_DATABASE_URL;
    try {
      const url = readQaDatabaseUrl();
      assert.match(url, new RegExp(`/${APPROVED_QA_DATABASE_NAME}$`));
      assert.match(url, new RegExp(`:${APPROVED_QA_DATABASE_PORT}/`));
    } finally {
      if (saved !== undefined) process.env.QA_DATABASE_URL = saved;
    }
  });

  test("QA target constants match the approved manual-QA database", () => {
    assert.equal(APPROVED_QA_DATABASE_NAME, "soundhub_qa");
    assert.equal(APPROVED_QA_DATABASE_PORT, 5433);
    assert.notEqual(APPROVED_QA_DATABASE_NAME, APPROVED_TEST_DATABASE_NAME);
    assert.equal(APPROVED_QA_DATABASE_PORT, APPROVED_TEST_DATABASE_PORT);
  });
});
