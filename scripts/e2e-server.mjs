// Serveur des tests de bout en bout : base PGlite et boîte d'envoi jetables, build de
// production dans .next-e2e (sans conflit avec le serveur de développement), port 3100.
// E2E_DEV=1 : serveur de développement (plus lent, sans build préalable).
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const dir of [".data/e2e", ".data/e2e-outbox", ".data/e2e-attachments"]) rmSync(path.join(root, dir), { recursive: true, force: true });

const env = {
  ...process.env,
  NEXT_DIST_DIR: ".next-e2e",
  DATABASE_URL: "pglite:./.data/e2e",
  APP_URL: "http://localhost:3100",
  ALLOW_SELF_SIGNUP: "true",
  APP_ENV: "development",
  PASSWORD_SCRYPT_LOG_N: "14",
  EMAIL_TRANSPORT: "outbox",
  EMAIL_OUTBOX_DIR: ".data/e2e-outbox",
  ATTACHMENTS_DIR: ".data/e2e-attachments",
  NEXT_TELEMETRY_DISABLED: "1",
};
const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
if (!process.env.E2E_DEV) {
  const build = spawnSync(process.execPath, [next, "build"], { cwd: root, env, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const server = spawn(process.execPath, [next, process.env.E2E_DEV ? "dev" : "start", "--port", "3100"], { cwd: root, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 0));
