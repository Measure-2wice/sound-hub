// Fail-closed guard test for the recovery-user seed leaf.
//
// Background: Codex review (P0-001) flagged that the directly
// executable leaf script trusted any `TEST_DATABASE_URL` and
// could therefore reach a developer database or a remote
// database. The fix invokes `assertDisposableTestDatabase`
// BEFORE any Prisma client is constructed. This test pins the
// guard with both an inverse case (non-approved URL → throw
// without opening a connection) and a positive case (approved
// URL → succeeds). The inverse case MUST exit before any
// PrismaClient instantiation; the test asserts the absence of
// any network/Prisma call by catching the guard's error and
// verifying that the thrown error originates from the guard,
// not from a Prisma connection failure.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertDisposableTestDatabase,
  readTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../../../apps/api/src/lib/test-database.js";

describe("seed-recovery-user leaf is fail-closed", () => {
  test("non-approved TEST_DATABASE_URL throws TestDatabaseGuardError without opening a Prisma connection", () => {
    // The guard is fail-closed: a wrong port, wrong host, or
    // wrong database name throws TestDatabaseGuardError BEFORE
    // any other work happens.
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@localhost:5432/soundhub_m1_test",
        ),
      (err: unknown) => err instanceof TestDatabaseGuardError && /port/i.test(err.message),
    );
    assert.throws(
      () =>
        assertDisposableTestDatabase(
          "postgresql://soundhub:password@remote.example.com:5433/soundhub_m1_test",
        ),
      (err: unknown) => err instanceof TestDatabaseGuardError && /host/i.test(err.message),
    );
    assert.throws(
      () =>
        assertDisposableTestDatabase("postgresql://soundhub:password@localhost:5433/soundhub_dev"),
      (err: unknown) => err instanceof TestDatabaseGuardError && /database/i.test(err.message),
    );
  });

  test("missing TEST_DATABASE_URL throws before any guard work", () => {
    const prev = process.env.TEST_DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    try {
      // `readTestDatabaseUrl` throws TestDatabaseGuardError when
      // the env var is unset. `assertDisposableTestDatabase` then
      // throws for any non-empty-but-invalid input. Both paths
      // are guarded.
      assert.throws(
        () => readTestDatabaseUrl(),
        (err: unknown) => err instanceof TestDatabaseGuardError,
      );
      assert.throws(
        () => assertDisposableTestDatabase("not-a-url"),
        (err: unknown) => err instanceof TestDatabaseGuardError,
      );
    } finally {
      if (prev !== undefined) process.env.TEST_DATABASE_URL = prev;
    }
  });

  test("the approved target passes the guard", () => {
    // The positive case: the exact approved target is accepted.
    // We do NOT actually run the seed here (the disposable DB
    // may not be up in this test runner); we only assert the
    // guard itself returns the canonical origin.
    const result = assertDisposableTestDatabase(
      "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
    );
    assert.equal(result.host, "localhost");
    assert.equal(result.port, 5433);
    assert.equal(result.database, "soundhub_m1_test");
  });

  test("the guard is invoked from inside seedRecoveryUser before any PrismaClient is constructed", async () => {
    // Verify the guard runs FIRST: a non-approved URL surfaces
    // TestDatabaseGuardError (not a Prisma connection error or a
    // generic PrismaClientInitializationError). The import and
    // call mirror the production ordering — guard BEFORE
    // `new PrismaClient`.
    const { seedRecoveryUser } = await import("./seed-recovery-user.js");
    const prev = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      "postgresql://soundhub:password@localhost:5432/soundhub_m1_test";
    try {
      await assert.rejects(
        () => seedRecoveryUser("guard-test@example.test"),
        (err: unknown) => err instanceof TestDatabaseGuardError && /port/i.test(err.message),
      );
    } finally {
      if (prev !== undefined) process.env.TEST_DATABASE_URL = prev;
      else delete process.env.TEST_DATABASE_URL;
    }
  });
});
