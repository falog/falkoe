fn main() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let no_openmp = std::env::var("CARGO_FEATURE_NO_OPENMP").is_ok();

    if target == "macos" || no_openmp {
        println!("cargo:rustc-env=GGML_NO_OPENMP=1");
        println!("cargo:rustc-env=WHISPER_NO_OPENMP=1");
    }
    tauri_build::build()
}
