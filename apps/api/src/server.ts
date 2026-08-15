// Server entry point. Kept separate from the app builder so that the route
// tests can import `buildApp` without triggering `app.listen()` at module
// load time.
import { buildApp } from "./index.js";

const { app } = buildApp();
const port = Number(process.env.PORT_API ?? process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`🚀 SoundHub API server running on http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/api/health`);
});
