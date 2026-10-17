// Usage: npm run create-agent -- <username> <password> [Display Name]
// In Docker: docker compose exec backend node dist/cli/create-agent.js <username> <password> [Display Name]
import { hashPassword } from "../api/auth.js";
import { initDb, pool } from "../db/db.js";

const [username, password, displayName] = process.argv.slice(2);
if (!username || !password || !/^[a-z0-9_]{2,32}$/.test(username)) {
  console.error("usage: create-agent <username (a-z, 0-9, _)> <password> [Display Name]");
  process.exit(1);
}
await initDb();
await pool.query(
  `INSERT INTO agents (username, display_name, password_hash) VALUES ($1,$2,$3)
   ON CONFLICT (username) DO UPDATE SET display_name=EXCLUDED.display_name, password_hash=EXCLUDED.password_hash`,
  [username, displayName || username, hashPassword(password)],
);
console.log(`agent "${username}" is ready`);
await pool.end();
