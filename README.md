# Falkoe (ふぁるこえ)

**Voice-powered language learning app**  
あなたの声で学ぶ、言語学習アプリ

---

## 📸 Screenshots

_Coming soon..._

---

## 🌟 Concept / コンセプト

### 🌍 Cross-platform

This app runs on multiple platforms: **Windows (msi), Linux (deb / rpm), and macOS**.

---

### 皆さんは、暗記が得意ですか？

私は、「覚える」という作業がずっと苦手でした。  
ですがあるとき、自分の声で作った英単語帳を使ってみたのです。

すると――驚くほど記憶に残りました。  
「自分の声」には、思っていた以上の力があると実感しました。

---

語学学習において、**自分の声を確認すること**は避けて通れない道だと思っています。  
だから私は、**声を活用した、シンプルな言語学習アプリ**を作りました。

---

このアプリでは、あなた自身の声を使って：

- **Anki 用のデッキを自動生成**
- **発音やフレーズ練習を記録・振り返り**

ができます。  
（※ 練習風景を動画として残す機能は、今後の構想です）

---

**見本の声、あなたの声、そして私ふぁるの声。**  
言語学習のための「声」が、ここに集まります。

---

### 🗣️ 言ってほしいセリフ、録音してみたいフレーズがあれば、ぜひ投稿してください。

**私、ふぁるも手伝います。**

---

これが「**ふぁる化**」。  
あなたも一緒に、「**ふぁるこえ**」になりましょう。

---

### Are you good at memorization?

I have always struggled with memorizing things.  
One day, I tried using a vocabulary deck made with **my own voice**.

The result surprised me — the words stayed in my memory far better than expected.  
That was when I realized how powerful **your own voice** can be.

---

In language learning, I believe that **listening to and checking your own voice** is unavoidable.  
That belief led me to create a **simple language learning app centered around voice**.

---

With this app, you can use _your own voice_ to:

- **Automatically generate Anki decks**
- **Record and review pronunciation and phrase practice**

(Recording practice as video is a planned feature for the future.)

---

**Sample voices, your voice, and my voice — Falkoe's voice.**  
All the voices needed for language learning come together here.

---

### 🗣️ If there's a sentence you want spoken or a phrase you want to record, feel free to share it.

**I, Falkoe, will help you.**

---

This is **"Fal-fication."**  
Join me, and let's become **"Falkoe voices."**

---

## 🔄 声の共有 / Voice Sharing

このアプリでは、録音した音声を他のユーザーと共有できます（予定）。

- **自分の発音を投稿**
- **他のユーザーの音声を参考に**
- **コミュニティで学び合う**
- **P2P方式で直接共有**

あなたの声が、誰かの学びを助けるかもしれません。

---

Share your recorded voices with other users (planned):

- **Post your pronunciation**
- **Learn from others' voices**
- **Build a learning community together**
- **Direct P2P sharing**

Your voice might help someone else's learning journey.

---

## ✨ Features / 機能

- ✅ **マイク録音** — 自分の声を簡単に録音
- ✅ **音声認識 (Whisper)** — ローカルで音声をテキスト化
- ✅ **Anki デッキ生成** — 録音からAnki用のデッキを自動作成
- ✅ **クロスプラットフォーム** — Windows / Linux / macOS 対応
- 🚧 **音声共有 (P2P)** — ユーザー間で音声を共有（開発中）
- 🚧 **練習動画の記録** — 発音練習を動画で残す（予定）

---

- ✅ **Mic recording** — Record your voice easily
- ✅ **Speech recognition (Whisper)** — Local, offline speech-to-text
- ✅ **Anki deck generation** — Auto-generate Anki decks from recordings
- ✅ **Cross-platform** — Windows / Linux / macOS support
- 🚧 **Voice sharing (P2P)** — Share voices between users (in development)
- 🚧 **Practice video recording** — Save pronunciation practice as video (planned)

---

## 🚀 Getting Started / はじめ方

### 1. Download / ダウンロード

Pre-built binaries are available on the GitHub Releases page:

**https://github.com/falog/falkoe/releases**

### 2. Install / インストール

各プラットフォームのインストール方法は下記を参照してください。  
See platform-specific installation instructions below.

### 3. Launch / 起動

アプリを起動して、マイク録音から始めましょう！  
Launch the app and start recording with your microphone!

---

## 📦 Installation / インストール

### 🪟 Windows

#### Install

Download the `.msi` file and run it.

`.msi` ファイルをダウンロードして実行してください。

#### ⚠️ Windows SmartScreen について / Notice

本アプリは現在、コード署名されていません。

初回起動時に Windows SmartScreen の警告が表示される場合がありますが、問題ありません。

以下の手順で起動できます：

1. 「詳細情報」をクリック
2. 「実行」を選択

---

This application is currently unsigned.

On first launch, Windows may show a SmartScreen warning.  
Please click **"More info" → "Run anyway"** to continue.

---

### 🐧 Linux

#### Debian / Ubuntu (.deb)

**Install:**

```bash
sudo dpkg -i falkoe_*.deb
```

**Uninstall:**

```bash
sudo apt remove falkoe
```

#### Fedora / RHEL / Rocky Linux (.rpm)

**Install:**

```bash
sudo rpm -i falkoe-*.rpm
```

**Uninstall:**

```bash
sudo rpm -e falkoe
```

#### AppImage

Make it executable and run:

```bash
chmod +x falkoe-*.AppImage
./falkoe-*.AppImage
```

---

### 🍎 macOS

#### Install

基本は `.dmg` を使います。

1. Releases から `.dmg` をダウンロードして開く
2. 表示された `Falkoe.app` を `Applications`（アプリケーション）へドラッグ
3. `Applications` から起動

※ もし `.dmg` が無い場合は、`Falkoe.app`（または `.app` を含むアーカイブ）をダウンロードして `Applications` に移動してください。

#### ⚠️ Gatekeeper について / Notice

本アプリは現在、コード署名されていません。

初回起動時に警告が出る場合は、`Falkoe.app` を **右クリック → 開く** で起動できます。

---

Download the `.dmg` file and open it:

1. Download and open the `.dmg` from Releases
2. Drag `Falkoe.app` into `Applications`
3. Launch it from `Applications`

If the `.dmg` is not available, download `Falkoe.app` (or an archive containing it) and move it into `Applications`.

This application is currently unsigned.
If Gatekeeper blocks the first launch, you can open it via **Right-click → Open**.

`.dmg` ファイルをダウンロードして開いてください。

1. Drag **Falkoe.dmg** to the **Applications** folder
2. Open Falkoe from Applications

---

1. **Falkoe.dmg** を **アプリケーション** フォルダにドラッグ
2. アプリケーションからFalkoeを起動

If macOS blocks the app on first launch:

初回起動時に警告が表示された場合は：

1. Right-click the app in Applications
2. Select **Open**
3. Click **Open** again to confirm

または  
**システム設定 → プライバシーとセキュリティ** から許可できます。

Alternatively, you can allow it from  
**System Settings → Privacy & Security**.

---

## 🛠️ Tech Stack / 技術スタック

### Core / コア

- **Tauri** — クロスプラットフォームデスクトップアプリ / cross-platform desktop framework
- **Rust** — バックエンド処理・音声処理 / backend logic and audio processing
- **React + TypeScript** — フロントエンド / frontend UI

### Audio & Language / 音声・言語処理

- **Whisper (local / offline)** — 音声認識 / speech-to-text
- **MediaRecorder / native mic recording** — マイク録音
- **Anki-compatible deck generation** — Anki互換デッキ生成

### Platform / 対応プラットフォーム

- **Windows**: MSI
- **Linux**: DEB / RPM / AppImage
- **macOS**: .dmg

---

## 🧩 Project Structure / プロジェクト構造

```
.
├── src/              # React frontend
├── src-tauri/        # Tauri / Rust backend
├── public/
├── dist/
└── README.md
```

---

## 🔧 Development / 開発

### Prerequisites / 前提条件

- Node.js (LTS v24+)
- Rust (latest stable)
- Tauri CLI

### Setup

```bash
# Clone repository
git clone https://github.com/falog/falkoe.git
cd falkoe

# Install dependencies
pnpm install

# Run development server
pnpm run tauri dev
```

### Build

```bash
# Build for your platform
pnpm tauri build
```

Bundled files are generated under:

```
src-tauri/target/release/bundle/
```

**Available formats:**

- **Windows**: `.msi`
- **Linux**: `.deb`, `.rpm`, `.AppImage`
- **macOS**: `.dmg`

---

## 🤝 Contributing / 貢献

Contributions are welcome!

貢献を歓迎します！

Please feel free to:

- Report bugs / バグ報告
- Suggest features / 機能提案
- Submit pull requests / プルリクエスト
- Share your voice recordings / 音声の共有

---

## 📄 License / ライセンス

This project is licensed under the MIT License.

See [LICENSE](LICENSE) file for details.

---

## 👤 Author / 作者

**fal (ふぁる)**

- GitHub: [@falog](https://github.com/falog)
- Project: [falkoe](https://github.com/falog/falkoe)

---

## 🙏 Acknowledgments / 謝辞

- [Tauri](https://tauri.app/) — Desktop app framework
- [Whisper](https://github.com/openai/whisper) — Speech recognition
- [Anki](https://apps.ankiweb.net/) — Spaced repetition learning

---

**Let's learn together with our voices!**  
**声を使って、一緒に学びましょう！**
