// Server entry point. Kept separate from the app builder so that the route
// tests can import `buildApp` without triggering `app.listen()` at module
// load time.
//
// The deployed entry point runs the bounded startup smoke before
// constructing the app so the managed-vs-deterministic selection
// is driven by a real network probe. Test code never invokes
// `buildAppWithSmoke`; tests call `buildApp` directly with mocked
// services so they remain network-free.
import { buildAppWithSmoke } from "./index.js";

async function main(): Promise<void> {
  const { app } = await buildAppWithSmoke();
  const port = Number(process.env.PORT_API ?? process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`🚀 SoundHub API server running on http://localhost:${port}`);
    console.log(`📊 Health check: http://localhost:${port}/api/health`);
  });
}

main().catch((err: unknown) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
