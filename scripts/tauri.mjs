import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);

// pnpm / shells can sometimes preserve quotes in argv on Windows.
// Strip a single pair of wrapping quotes so downstream CLIs don't choke.
const args = rawArgs.map((arg) =>
  arg.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
);

function checkWindowsBundledTools(args) {
  if (process.platform !== "win32") return;

  // We only enforce this for packaging commands by default.
  const subcmd = args[0];
  const isPackaging = subcmd === "build" || subcmd === "bundle";

  const cwd = process.cwd();
  const resourcesBin = path.resolve(cwd, "src-tauri", "resources", "bin");
  const resourcesMecab = path.resolve(cwd, "src-tauri", "resources", "mecab");

  const ffmpegExe = path.join(resourcesBin, "ffmpeg.exe");
  const praatconExe = path.join(resourcesBin, "praatcon.exe");
  const praatExe = path.join(resourcesBin, "praat.exe");
  const mecabExe = path.join(resourcesBin, "mecab.exe");

  const missing = [];
  if (!existsSync(ffmpegExe)) missing.push(ffmpegExe);

  // Optional tools
  const hasPraat = existsSync(praatconExe) || existsSync(praatExe);
  const hasMecab = existsSync(mecabExe);
  const dicHint = path.join(resourcesMecab, "ipadic", "dicrc");

  const allowMissing =
    process.env.FALKOE_ALLOW_MISSING_BUNDLED_TOOLS === "1" ||
    process.env.FALKOE_ALLOW_MISSING_BUNDLED_TOOLS === "true";

  if (missing.length > 0) {
    const msg = [
      "[tauri wrapper] Windows bundle note:",
      "  Bundled ffmpeg is missing. Your MSI will NOT include ffmpeg unless you place it here:",
      `  - ${ffmpegExe}`,
      "  Falkoe will try PATH fallback in dev, but end-users may not have ffmpeg installed.",
      "  (See README: Bundled Tools (ffmpeg))",
    ].join("\n");
    // For distribution builds we want the MSI to work out of the box.
    // ffmpeg is required for audio conversion, so fail packaging by default.
    if (isPackaging && !allowMissing) {
      console.error(msg);
      process.exit(1);
    } else {
      console.warn(msg);
    }
  }

  if (!hasPraat) {
    console.warn(
      [
        "[tauri wrapper] Windows bundle note:",
        "  Praat is not bundled (optional). If you want stable pitch extraction, place one of:",
        `  - ${praatconExe}`,
        `  - ${praatExe}`,
        "  (See README: Bundled Tools (Praat))",
      ].join("\n")
    );
  }

  if (!hasMecab) {
    console.warn(
      [
        "[tauri wrapper] Windows bundle note:",
        "  MeCab is not bundled (optional). If you want improved JA accent tokenization, place:",
        `  - ${mecabExe}`,
        "  And a dictionary under src-tauri/resources/mecab (e.g. ipadic).",
        "  (See README: Optional Tool (MeCab))",
      ].join("\n")
    );
  } else if (!existsSync(dicHint)) {
    console.warn(
      [
        "[tauri wrapper] Windows bundle note:",
        "  MeCab is bundled but dictionary (ipadic) not detected at:",
        `  - ${dicHint}`,
        "  MeCab may not work without a dictionary.",
      ].join("\n")
    );
  }
}

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

checkWindowsBundledTools(args);

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
