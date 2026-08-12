// Global teardown. The webServer lifecycle is managed by Playwright itself;
// this hook is intentionally minimal so the disposable test database can be
// reused across runs. The `pnpm db:test:down` script destroys the test
// service and its ephemeral volume explicitly.

export default function globalTeardown(): void {
  console.log(
    "▶ Playwright global teardown (no-op; run `pnpm db:test:down` to drop the disposable test service).",
  );
}
