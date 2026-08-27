/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APPROVED_QA_DATABASE_HOSTS,
  APPROVED_QA_DATABASE_NAME,
  APPROVED_QA_DATABASE_PORT,
  APPROVED_TEST_DATABASE_HOSTS,
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
  assertApprovedQaDatabase,
  assertDisposableTestDatabase,
  assertNotQaDatabase,
  readQaDatabaseUrl,
  readTestDatabaseUrl,
  resolveApprovedQaDatabaseUrl,
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

describe("QA mutation guard (P0-001)", () => {
  // Codex review P0-001: the QA wrappers used to validate only the
  // database name. A URL such as `postgresql://remote-host:5432/soundhub_qa`
  // would silently pass, allowing migrate/seed to mutate an
  // unintended remote database. The guard below rejects every
  // combination of wrong host / wrong port / wrong scheme /
  // wrong database name so the QA wrappers fail closed.

  test("accepts the approved loopback QA target on localhost", () => {
    const result = assertApprovedQaDatabase(
      "postgresql://soundhub:password@localhost:5433/soundhub_qa",
    );
    assert.equal(result.host, "localhost");
    assert.equal(result.port, 5433);
    assert.equal(result.database, "soundhub_qa");
  });

  test("accepts the approved loopback QA target on 127.0.0.1", () => {
    const result = assertApprovedQaDatabase(
      "postgresql://soundhub:password@127.0.0.1:5433/soundhub_qa",
    );
    assert.equal(result.host, "127.0.0.1");
  });

  test("accepts the approved loopback QA target on ::1", () => {
    const result = assertApprovedQaDatabase(
      "postgresql://soundhub:password@[::1]:5433/soundhub_qa",
    );
    assert.equal(result.host, "::1");
  });

  test("rejects a non-loopback remote host even when the database name is correct", () => {
    // The P0-001 reproduction: a remote host exposing a database
    // named `soundhub_qa` must still be rejected. Database name
    // alone is insufficient — the host must be loopback.
    assert.throws(
      () =>
        assertApprovedQaDatabase("postgresql://soundhub:password@db.example.com:5433/soundhub_qa"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError &&
        /db\.example\.com/.test(err.message) &&
        /not the approved local host/.test(err.message),
    );
  });

  test("rejects a remote host with the wrong port and wrong database name (every branch fails closed)", () => {
    assert.throws(
      () =>
        assertApprovedQaDatabase("postgresql://soundhub:password@db.example.com:5432/some_other"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError && /db\.example\.com/.test(err.message),
    );
  });

  test("rejects an IPv4 non-loopback address (10.0.0.1)", () => {
    assert.throws(
      () => assertApprovedQaDatabase("postgresql://soundhub:password@10.0.0.1:5433/soundhub_qa"),
      (err: unknown) => err instanceof TestDatabaseGuardError,
    );
  });

  test("rejects the wrong port (5432) even when the host and database name are correct", () => {
    assert.throws(
      () => assertApprovedQaDatabase("postgresql://soundhub:password@localhost:5432/soundhub_qa"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError && /port 5432 must be 5433/.test(err.message),
    );
  });

  test("rejects a non-postgres scheme", () => {
    assert.throws(
      () => assertApprovedQaDatabase("mysql://soundhub:password@localhost:3306/soundhub_qa"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError && /postgresql:\/\//.test(err.message),
    );
  });

  test("rejects an invalid URL", () => {
    assert.throws(
      () => assertApprovedQaDatabase("not-a-url"),
      (err: unknown) => err instanceof TestDatabaseGuardError,
    );
  });

  test("rejects a wrong database name even on the approved host and port", () => {
    assert.throws(
      () =>
        assertApprovedQaDatabase(
          "postgresql://soundhub:password@localhost:5433/soundhub_production",
        ),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError &&
        /soundhub_production/.test(err.message) &&
        /must be exactly 'soundhub_qa'/.test(err.message),
    );
  });

  test("rejects the destructive test database name (same-DB-name isolation)", () => {
    // The QA wrappers must not target the destructive test database
    // either. The same-DB guard surfaces the QA-specific message so
    // the operator knows which database to point at.
    assert.throws(
      () =>
        assertApprovedQaDatabase("postgresql://soundhub:password@localhost:5433/soundhub_m1_test"),
      (err: unknown) =>
        err instanceof TestDatabaseGuardError &&
        /soundhub_m1_test/.test(err.message) &&
        /must be exactly 'soundhub_qa'/.test(err.message),
    );
  });

  test("resolveApprovedQaDatabaseUrl honors QA_DATABASE_URL when set", () => {
    const expected = "postgresql://soundhub:password@localhost:5433/soundhub_qa";
    const saved = process.env.QA_DATABASE_URL;
    process.env.QA_DATABASE_URL = expected;
    try {
      const result = resolveApprovedQaDatabaseUrl();
      assert.equal(result.url, expected);
      assert.equal(result.host, "localhost");
      assert.equal(result.port, 5433);
      assert.equal(result.database, "soundhub_qa");
    } finally {
      if (saved === undefined) delete process.env.QA_DATABASE_URL;
      else process.env.QA_DATABASE_URL = saved;
    }
  });

  test("resolveApprovedQaDatabaseUrl fails closed on a remote host with the right database name", () => {
    // End-to-end reproduction: the previous wrappers would happily
    // accept this URL. resolveApprovedQaDatabaseUrl is the centralised
    // entry point every QA wrapper must call, so it has to fail
    // closed even when QA_DATABASE_URL is set explicitly to a remote
    // host.
    const remote = "postgresql://soundhub:password@db.example.com:5433/soundhub_qa";
    const saved = process.env.QA_DATABASE_URL;
    process.env.QA_DATABASE_URL = remote;
    try {
      assert.throws(
        () => resolveApprovedQaDatabaseUrl(),
        (err: unknown) => err instanceof TestDatabaseGuardError,
      );
    } finally {
      if (saved === undefined) delete process.env.QA_DATABASE_URL;
      else process.env.QA_DATABASE_URL = saved;
    }
  });

  test("exports the exact approved QA host set for callers", () => {
    assert.ok(APPROVED_QA_DATABASE_HOSTS.has("localhost"));
    assert.ok(APPROVED_QA_DATABASE_HOSTS.has("127.0.0.1"));
    assert.ok(APPROVED_QA_DATABASE_HOSTS.has("::1"));
    assert.equal(APPROVED_QA_DATABASE_HOSTS.has("0.0.0.0"), false);
    assert.equal(APPROVED_QA_DATABASE_HOSTS.has("db.example.com"), false);
  });
});
