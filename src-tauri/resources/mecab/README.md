# MeCab resources

Place bundled MeCab dictionary files here if you want Falkoe to use MeCab without requiring a system installation.

Expected layout (example):

- `src-tauri/resources/bin/mecab.exe` (Windows)
- `src-tauri/resources/bin/mecab` (macOS/Linux)
- `src-tauri/resources/mecab/ipadic/` (dictionary directory containing `dicrc`)

At runtime, Falkoe will prefer bundled resources under Tauri's `resource_dir` when available.
