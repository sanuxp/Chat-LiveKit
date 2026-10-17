import { startApi } from "./api/server.js";
import { initDb } from "./db/db.js";
import { resumeWaiting } from "./routing/startup.js";
import { loadTools, ToolConfigError, watchConfig } from "./tools/registry.js";

async function main() {
  await initDb();
  await loadTools(); // refuses to start (clear message) if tools.yaml is invalid
  watchConfig();
  await startApi();
  await resumeWaiting().catch((e) => console.error("resumeWaiting failed:", e?.message));
  console.log("backend ready");
}

main().catch((err) => {
  if (err instanceof ToolConfigError) console.error(`\nCONFIG ERROR\n${err.message}\n`);
  else console.error("fatal:", err?.message ?? err);
  process.exit(1);
});
