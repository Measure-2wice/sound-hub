// Regression coverage for `scripts/db-qa-env.mjs`.
//
// P0-001 (Codex review) flagged that the QA wrappers
// (db-qa-wait / db-qa-migrate / db-qa-seed / dev-qa) previously
// validated only the database name and would happily accept a URL
// like `postgresql://remote-host:5432/soundhub_qa`. The wrappers now
// share `resolveApprovedQaDatabaseUrl` from `db-qa-env.mjs`, which
// rejects non-postgres schemes, non-loopback hosts, the wrong port,
// and the wrong database name. This suite pins the helper's every
// rejection branch so a regression in the guard cannot silently
// ship.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  APPROVED_QA,
  assertApprovedQaDatabaseUrl,
  resolveApprovedQaDatabaseUrl,
} from "./db-qa-env.mjs";

const APPROVED_URL = "postgresql://soundhub:password@localhost:5433/soundhub_qa";

describe("assertApprovedQaDatabaseUrl", () => {
  test("accepts the approved loopback QA target", () => {
    const result = assertApprovedQaDatabaseUrl(APPROVED_URL);
    assert.equal(result.url, APPROVED_URL);
    assert.equal(result.host, "localhost");
    assert.equal(result.port, 5433);
    assert.equal(result.database, "soundhub_qa");
  });

  test("accepts 127.0.0.1 and ::1 as loopback hosts", () => {
    for (const host of ["127.0.0.1", "::1"]) {
      const url = `postgresql://soundhub:password@${host === "::1" ? "[::1]" : host}:5433/soundhub_qa`;
      const result = assertApprovedQaDatabaseUrl(url);
      assert.equal(result.host, host);
    }
  });

  test("rejects a remote host even when the database name is correct (P0-001 reproduction)", () => {
    assert.throws(
      () =>
        assertApprovedQaDatabaseUrl(
          "postgresql://soundhub:password@db.example.com:5433/soundhub_qa",
        ),
      (err) =>
        err instanceof Error &&
        /db\.example\.com/.test(err.message) &&
        /not the approved local host/.test(err.message),
    );
  });

  test("rejects an IPv4 non-loopback address (10.0.0.1)", () => {
    assert.throws(
      () => assertApprovedQaDatabaseUrl("postgresql://soundhub:password@10.0.0.1:5433/soundhub_qa"),
      (err) => err instanceof Error,
    );
  });

  test("rejects the wrong port (5432) even when the host and database name are correct", () => {
    assert.throws(
      () =>
        assertApprovedQaDatabaseUrl("postgresql://soundhub:password@localhost:5432/soundhub_qa"),
      (err) => err instanceof Error && /port 5432 must be 5433/.test(err.message),
    );
  });

  test("rejects a non-postgres scheme", () => {
    assert.throws(
      () => assertApprovedQaDatabaseUrl("mysql://soundhub:password@localhost:3306/soundhub_qa"),
      (err) => err instanceof Error && /postgresql:\/\//.test(err.message),
    );
  });

  test("rejects an invalid URL", () => {
    assert.throws(
      () => assertApprovedQaDatabaseUrl("not-a-url"),
      (err) => err instanceof Error && /not a valid URL/.test(err.message),
    );
  });

  test("rejects a wrong database name even on the approved host and port", () => {
    assert.throws(
      () =>
        assertApprovedQaDatabaseUrl(
          "postgresql://soundhub:password@localhost:5433/soundhub_production",
        ),
      (err) => err instanceof Error && /must be exactly 'soundhub_qa'/.test(err.message),
    );
  });

  test("rejects the destructive test database name (same-DB-name isolation)", () => {
    assert.throws(
      () =>
        assertApprovedQaDatabaseUrl(
          "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
        ),
      (err) => err instanceof Error,
    );
  });
});

describe("resolveApprovedQaDatabaseUrl", () => {
  let saved;
  before(() => {
    saved = process.env.QA_DATABASE_URL;
  });
  after(() => {
    if (saved === undefined) delete process.env.QA_DATABASE_URL;
    else process.env.QA_DATABASE_URL = saved;
  });

  test("honors QA_DATABASE_URL when set and valid", () => {
    process.env.QA_DATABASE_URL = APPROVED_URL;
    const result = resolveApprovedQaDatabaseUrl();
    assert.equal(result.url, APPROVED_URL);
    assert.equal(result.host, "localhost");
    assert.equal(result.port, 5433);
    assert.equal(result.database, "soundhub_qa");
  });

  test("falls back to the approved default when QA_DATABASE_URL is unset", () => {
    delete process.env.QA_DATABASE_URL;
    const result = resolveApprovedQaDatabaseUrl();
    assert.equal(result.url, APPROVED_QA.defaultUrl);
    assert.equal(result.host, "localhost");
    assert.equal(result.port, APPROVED_QA.port);
    assert.equal(result.database, APPROVED_QA.name);
  });

  test("fails closed on a remote host with the right database name (end-to-end)", () => {
    process.env.QA_DATABASE_URL = "postgresql://soundhub:password@db.example.com:5433/soundhub_qa";
    assert.throws(
      () => resolveApprovedQaDatabaseUrl(),
      (err) => err instanceof Error && /db\.example\.com/.test(err.message),
    );
  });

  test("fails closed on the wrong port even with an approved host and database", () => {
    process.env.QA_DATABASE_URL = "postgresql://soundhub:password@localhost:5432/soundhub_qa";
    assert.throws(
      () => resolveApprovedQaDatabaseUrl(),
      (err) => err instanceof Error && /port 5432 must be 5433/.test(err.message),
    );
  });
});
