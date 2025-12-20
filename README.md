# Falkoe

A cross-platform desktop application built with **Tauri v2**, **React**, and **TypeScript**.

Falkoe is designed to provide a lightweight, fast, and native-feeling experience while keeping the frontend fully web-based.

---

## ✨ Features

- ⚡ **Fast startup** and low memory usage powered by Tauri
- 🖥️ **Cross-platform** support (Windows / Linux)
- 🧩 **Modern frontend** stack (React + Vite + TypeScript)
- 📦 **Native installers** (`.msi`, `.deb`, AppImage)
- 🔐 **Secure by default** with Tauri's security model

---

## 🛠 Tech Stack

### Frontend

- React
- TypeScript
- Vite
- pnpm

### Backend

- Rust (Tauri v2)

### Build / CI

- Tauri bundler
- GitHub Actions

---

## 🚀 Development

### Prerequisites

- **Node.js** 20+
- **pnpm**
- **Rust** (stable)
- **Platform-specific dependencies:**
  - **Linux:** `webkit2gtk`, `gtk3`, `openssl`, `alsa` (see workflow)

### Install dependencies

```bash
pnpm install
```

### Run in development mode

```bash
pnpm tauri dev
```

---

## 📦 Build

Build a production bundle:

```bash
pnpm tauri build
```

Generated files can be found in:

```
src-tauri/target/release/bundle/
```

**Examples:**

- **Windows:** `.msi`
- **Linux:** `.deb`, `.AppImage`

---

## 🐧 Linux (.deb)

### Install the generated deb package:

```bash
sudo dpkg -i falkoe_*.deb
```

### Uninstall:

```bash
sudo apt remove falkoe
```

---

## 🧩 Project Structure

```
.
├── src/            # React frontend
├── src-tauri/      # Tauri / Rust backend
├── public/
├── dist/
└── README.md
```

---

## Download

Pre-built binaries are available on the GitHub Releases page.

https://github.com/falog/falkoe/releases

---

## ⚠ Windows SmartScreen Notice

This application is currently unsigned.
Click "More info" → "Run anyway" on first launch.

---

## 👤 Author

**fal**

GitHub: [https://github.com/falog](https://github.com/falog)
