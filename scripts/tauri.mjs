import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
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
  const transcribeAvxExe = path.join(resourcesBin, "falkoe-transcribe-avx.exe");
  const transcribeAvx2Exe = path.join(
    resourcesBin,
    "falkoe-transcribe-avx2.exe"
  );
  const transcribeVulkanExe = path.join(
    resourcesBin,
    "falkoe-transcribe-vulkan.exe"
  );
  const praatconExe = path.join(resourcesBin, "praatcon.exe");
  const praatExe = path.join(resourcesBin, "praat.exe");
  const mecabExe = path.join(resourcesBin, "mecab.exe");
  const mecabDlls = [
    path.join(resourcesBin, "libmecab-2.dll"),
    path.join(resourcesBin, "libiconv-2.dll"),
    path.join(resourcesBin, "libintl-8.dll"),
    path.join(resourcesBin, "libcharset-1.dll"),
  ];

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
    const msg = [
      "[tauri wrapper] Windows bundle note:",
      "  Praat is not bundled. If you want stable pitch extraction, place one of:",
      `  - ${praatconExe}`,
      `  - ${praatExe}`,
    ].join("\n");

    // User requested Praat bundling for distribution builds.
    if (isPackaging && !allowMissing) {
      console.error(msg);
      process.exit(1);
    } else {
      console.warn(msg);
    }
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

  if (hasMecab) {
    const missingMecabDlls = mecabDlls.filter((p) => !existsSync(p));
    if (missingMecabDlls.length > 0) {
      console.warn(
        [
          "[tauri wrapper] Windows bundle note:",
          "  MeCab is bundled but required DLLs are missing next to mecab.exe.",
          "  This will typically crash/failed-to-launch with Windows error 126 (e.g. libiconv-2.dll not found).",
          "  Missing:",
          ...missingMecabDlls.map((p) => `  - ${p}`),
        ].join("\n")
      );
    }
  }

  // Transcribe helpers are required for Windows transcription.
  if (isPackaging) {
    const missingTranscribe = [];
    if (!existsSync(transcribeAvxExe)) missingTranscribe.push(transcribeAvxExe);
    if (!existsSync(transcribeAvx2Exe))
      missingTranscribe.push(transcribeAvx2Exe);
    if (missingTranscribe.length > 0 && !allowMissing) {
      console.error(
        [
          "[tauri wrapper] Windows bundle note:",
          "  Transcribe helper binaries are missing. Build will not be portable.",
          "  Missing:",
          ...missingTranscribe.map((p) => `  - ${p}`),
        ].join("\n")
      );
      process.exit(1);
    }

    // Vulkan helper is optional. If present, Falkoe can prefer it and fall back to CPU.
    if (!existsSync(transcribeVulkanExe)) {
      console.warn(
        [
          "[tauri wrapper] Windows bundle note:",
          "  Optional Vulkan transcribe helper is not bundled:",
          `  - ${transcribeVulkanExe}`,
          "  Falkoe will use CPU helper binaries.",
        ].join("\n")
      );
    }
  }
}

function buildWindowsTranscribeHelpers(args) {
  if (process.platform !== "win32") return;

  const subcmd = args[0];
  const isDev = subcmd === "dev";
  const isPackaging = subcmd === "build" || subcmd === "bundle";
  if (!isDev && !isPackaging) return;

  const cwd = process.cwd();
  const srcTauriDir = path.resolve(cwd, "src-tauri");
  const resourcesBin = path.resolve(srcTauriDir, "resources", "bin");
  mkdirSync(resourcesBin, { recursive: true });

  // Respect a preconfigured CARGO_TARGET_DIR (e.g. GitHub Actions sets a short
  // path like D:\t to avoid MSBuild/CMake deep path issues).
  const cargoTargetBase = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.resolve(srcTauriDir, "target");

  // In dev we only build the AVX helper for speed.
  const variants = isPackaging
    ? [
        { tag: "avx", outName: "falkoe-transcribe-avx.exe" },
        { tag: "avx2", outName: "falkoe-transcribe-avx2.exe" },
      ]
    : [{ tag: "avx", outName: "falkoe-transcribe-avx.exe" }];

  // Optional: Vulkan-enabled helper (requires Vulkan SDK / glslc at build time).
  // Opt-in to avoid breaking CI/dev machines that don't have it installed.
  const wantVulkanHelper =
    process.env.FALKOE_BUILD_VULKAN_HELPER === "1" ||
    process.env.FALKOE_BUILD_VULKAN_HELPER === "true";
  if (isPackaging && wantVulkanHelper) {
    // Build it as baseline AVX for maximum compatibility.
    variants.push({ tag: "vulkan", outName: "falkoe-transcribe-vulkan.exe" });
  }

  for (const v of variants) {
    const targetDir = path.resolve(cargoTargetBase, `transcribe-${v.tag}`);
    const profileDir = isPackaging ? "release" : "debug";
    const builtExe = path.resolve(
      targetDir,
      profileDir,
      "transcribe_wav_json.exe"
    );
    const destExe = path.resolve(resourcesBin, v.outName);

    const env = { ...process.env };
    env.CARGO_TARGET_DIR = targetDir;

    // Ensure we don't accidentally build for the build machine.
    env.GGML_NATIVE = "OFF";

    // Optional GPU backend (Vulkan) build.
    // If this fails on your environment, you can set FALKOE_ALLOW_MISSING_BUNDLED_TOOLS=1
    // to package CPU-only builds.
    const cargoFeatures = [];
    if (v.tag === "vulkan") {
      cargoFeatures.push("whisper-vulkan");
    }

    // Baseline AVX build (Sandy Bridge class).
    env.GGML_AVX = "ON";
    env.GGML_AVX2 = v.tag === "avx2" ? "ON" : "OFF";
    env.GGML_BMI2 = "OFF";
    env.GGML_AVX512 = "OFF";
    env.GGML_AVX512_VBMI = "OFF";
    env.GGML_AVX512_VNNI = "OFF";
    env.GGML_AVX512_BF16 = "OFF";
    env.GGML_AVX_VNNI = "OFF";
    // FMA/F16C are implied for AVX2 on MSVC; keep explicit for baseline.
    env.GGML_FMA = v.tag === "avx2" ? (env.GGML_FMA ?? "ON") : "OFF";
    env.GGML_F16C = v.tag === "avx2" ? (env.GGML_F16C ?? "ON") : "OFF";

    const cargoArgs = [
      "build",
      "--bin",
      "transcribe_wav_json",
      ...(cargoFeatures.length ? ["--features", cargoFeatures.join(",")] : []),
      ...(isPackaging ? ["--release"] : []),
    ];

    const res = spawnSync("cargo", cargoArgs, {
      cwd: srcTauriDir,
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });

    if (res.status !== 0) {
      const requireVulkanHelper =
        process.env.FALKOE_REQUIRE_VULKAN_HELPER === "1" ||
        process.env.FALKOE_REQUIRE_VULKAN_HELPER === "true";

      if (v.tag === "vulkan" && !requireVulkanHelper) {
        console.warn(
          [
            `[tauri wrapper] Optional Vulkan helper build failed (tag=${v.tag}).`,
            "  This usually means Vulkan SDK (including glslc) is not installed.",
            "  Continuing with CPU helpers only.",
            "  To require Vulkan helper, set FALKOE_REQUIRE_VULKAN_HELPER=1.",
          ].join("\n")
        );
        continue;
      }

      console.error(
        `[tauri wrapper] Failed to build transcribe helper (${v.tag}).`
      );
      process.exit(res.status ?? 1);
    }

    if (!existsSync(builtExe)) {
      if (v.tag === "vulkan") {
        console.warn(
          [
            `[tauri wrapper] Optional Vulkan helper exe not found: ${builtExe}`,
            "  Continuing with CPU helpers only.",
          ].join("\n")
        );
        continue;
      }

      console.error(
        `[tauri wrapper] Expected helper exe not found: ${builtExe}`
      );
      process.exit(1);
    }

    // Replace atomically (best-effort) so the file is never half-written.
    const tmpDest = `${destExe}.tmp`;
    rmSync(tmpDest, { force: true });
    cpSync(builtExe, tmpDest, { force: true });
    rmSync(destExe, { force: true });
    renameSync(tmpDest, destExe);
    console.log(`[tauri wrapper] Built transcribe helper -> ${destExe}`);
  }
}

function buildUnixTranscribeHelpers(args) {
  if (process.platform === "win32") return;

  const subcmd = args[0];
  const isDev = subcmd === "dev";
  const isPackaging = subcmd === "build" || subcmd === "bundle";
  if (!isDev && !isPackaging) return;

  // Opt-in to avoid slowing down normal dev/builds.
  const wantHelpers =
    process.env.FALKOE_BUNDLE_TRANSCRIBE_HELPERS === "1" ||
    process.env.FALKOE_BUNDLE_TRANSCRIBE_HELPERS === "true";
  if (!wantHelpers) return;

  const cwd = process.cwd();
  const srcTauriDir = path.resolve(cwd, "src-tauri");
  const resourcesBin = path.resolve(srcTauriDir, "resources", "bin");
  mkdirSync(resourcesBin, { recursive: true });

  const cargoTargetBase = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.resolve(srcTauriDir, "target");

  const allowMissing =
    process.env.FALKOE_ALLOW_MISSING_BUNDLED_TOOLS === "1" ||
    process.env.FALKOE_ALLOW_MISSING_BUNDLED_TOOLS === "true";

  const wantVulkanHelper =
    process.env.FALKOE_BUILD_VULKAN_HELPER === "1" ||
    process.env.FALKOE_BUILD_VULKAN_HELPER === "true";
  const requireVulkanHelper =
    process.env.FALKOE_REQUIRE_VULKAN_HELPER === "1" ||
    process.env.FALKOE_REQUIRE_VULKAN_HELPER === "true";

  const wantMetalHelper =
    process.env.FALKOE_BUILD_METAL_HELPER === "1" ||
    process.env.FALKOE_BUILD_METAL_HELPER === "true";
  const requireMetalHelper =
    process.env.FALKOE_REQUIRE_METAL_HELPER === "1" ||
    process.env.FALKOE_REQUIRE_METAL_HELPER === "true";

  const variants = [];

  // Always build a CPU helper if helpers are enabled.
  variants.push({
    tag: "cpu",
    outName: "falkoe-transcribe-cpu",
    features: process.platform === "darwin" ? ["no-openmp"] : [],
  });

  // Optional GPU helpers.
  if (process.platform === "linux" && wantVulkanHelper) {
    variants.push({
      tag: "vulkan",
      outName: "falkoe-transcribe-vulkan",
      features: ["whisper-vulkan"],
    });
  }
  if (process.platform === "darwin" && wantMetalHelper) {
    variants.push({
      tag: "metal",
      outName: "falkoe-transcribe-metal",
      features: ["whisper-metal", "no-openmp"],
    });
  }

  for (const v of variants) {
    const targetDir = path.resolve(cargoTargetBase, `transcribe-${v.tag}`);
    const profileDir = isPackaging ? "release" : "debug";
    const builtExe = path.resolve(targetDir, profileDir, "transcribe_wav_json");
    const destExe = path.resolve(resourcesBin, v.outName);

    const env = { ...process.env };
    env.CARGO_TARGET_DIR = targetDir;

    // Avoid accidentally building for the build machine.
    env.GGML_NATIVE = "OFF";

    // Keep behavior consistent with the app build on macOS.
    if (process.platform === "darwin") {
      env.GGML_NO_OPENMP = env.GGML_NO_OPENMP ?? "1";
      env.WHISPER_NO_OPENMP = env.WHISPER_NO_OPENMP ?? "1";
    }

    const cargoArgs = [
      "build",
      "--bin",
      "transcribe_wav_json",
      ...(v.features.length ? ["--features", v.features.join(",")] : []),
      ...(isPackaging ? ["--release"] : []),
    ];

    const res = spawnSync("cargo", cargoArgs, {
      cwd: srcTauriDir,
      stdio: "inherit",
      env,
      shell: false,
    });

    if (res.status !== 0) {
      if (v.tag === "vulkan" && !requireVulkanHelper) {
        console.warn(
          [
            "[tauri wrapper] Optional Vulkan helper build failed.",
            "  Continuing without Vulkan helper.",
          ].join("\n")
        );
        continue;
      }
      if (v.tag === "metal" && !requireMetalHelper) {
        console.warn(
          [
            "[tauri wrapper] Optional Metal helper build failed.",
            "  Continuing without Metal helper.",
          ].join("\n")
        );
        continue;
      }

      const requiredMsg =
        v.tag === "vulkan"
          ? "To require Vulkan helper, set FALKOE_REQUIRE_VULKAN_HELPER=1."
          : v.tag === "metal"
            ? "To require Metal helper, set FALKOE_REQUIRE_METAL_HELPER=1."
            : "";

      const msg = [
        `[tauri wrapper] Failed to build transcribe helper (${v.tag}).`,
        requiredMsg,
      ]
        .filter(Boolean)
        .join("\n");

      if (allowMissing) {
        console.warn(msg);
        continue;
      }
      console.error(msg);
      process.exit(res.status ?? 1);
    }

    if (!existsSync(builtExe)) {
      const msg = `[tauri wrapper] Expected helper binary not found: ${builtExe}`;
      if (allowMissing && (v.tag === "vulkan" || v.tag === "metal")) {
        console.warn(msg);
        continue;
      }
      console.error(msg);
      process.exit(1);
    }

    const tmpDest = `${destExe}.tmp`;
    rmSync(tmpDest, { force: true });
    cpSync(builtExe, tmpDest, { force: true });
    rmSync(destExe, { force: true });
    renameSync(tmpDest, destExe);
    chmodSync(destExe, 0o755);
    console.log(`[tauri wrapper] Built transcribe helper -> ${destExe}`);
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

buildWindowsTranscribeHelpers(args);

buildUnixTranscribeHelpers(args);

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
