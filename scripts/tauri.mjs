import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);

// pnpm / shells can sometimes preserve quotes in argv on Windows.
// Strip a single pair of wrapping quotes so downstream CLIs don't choke.
const args = rawArgs.map((arg) =>
  arg.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
);

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
    // Mirror sync: if a file is deleted from src-tauri/resources, we don't want
    // it to linger in src-tauri/target/debug/resources.
    rmSync(copiedResourcesDir, { recursive: true, force: true });
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

// On Windows, spawning *.cmd directly can fail with EINVAL depending on how the
// environment is set up. Using `shell: true` routes through cmd.exe.
const bin = process.platform === "win32" ? "tauri" : "tauri";
const child = spawn(bin, args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[tauri wrapper] Failed to start tauri:", err);
  process.exit(1);
});
