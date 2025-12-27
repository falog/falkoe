import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

// In dev, Tauri may resolve bundled resources from src-tauri/target/debug/resources.
// Sync resources on each dev start so replaced audio/index.json are picked up.
if (args[0] === "dev") {
  const cwd = process.cwd();
  const srcResourcesDir = path.resolve(cwd, "src-tauri", "resources");
  const copiedResourcesDir = path.resolve(
    cwd,
    "src-tauri",
    "target",
    "debug",
    "resources"
  );

  if (existsSync(srcResourcesDir)) {
    mkdirSync(copiedResourcesDir, { recursive: true });
    cpSync(srcResourcesDir, copiedResourcesDir, {
      recursive: true,
      force: true,
    });
    console.log(`[tauri wrapper] Synced resources -> ${copiedResourcesDir}`);
  } else {
    console.warn(
      `[tauri wrapper] Source resources not found: ${srcResourcesDir}`
    );
  }
}

const bin = process.platform === "win32" ? "tauri.cmd" : "tauri";
const child = spawn(bin, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[tauri wrapper] Failed to start tauri:", err);
  process.exit(1);
});
