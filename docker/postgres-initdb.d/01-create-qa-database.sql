-- Manual-QA database bootstrap.
--
-- The `docker-compose.test.yml` PostgreSQL container is created with
-- `POSTGRES_DB=soundhub_m1_test`, so the destructive test target
-- exists from the very first startup. This initdb hook creates the
-- sibling `soundhub_qa` database so a manual-QA session has its
-- own disposable target that destructive repository tests cannot
-- reach (the API guard at apps/api/src/lib/test-database.ts refuses
-- to run a destructive script against `soundhub_qa` by name).
--
-- Files in /docker-entrypoint-initdb.d/*.sql are executed in
-- lexical order on the first startup of an empty data directory
-- (this directory is bind-mounted via docker-compose.test.yml).
-- Subsequent restarts of an existing data directory do not re-run
-- this hook, which is exactly what we want — a partially-migrated
-- QA database is left untouched by the dev workflow.

CREATE DATABASE soundhub_qa;
