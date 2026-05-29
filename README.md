# Monitor

A desktop floating widget that monitors OpenClash node connectivity and aggregates AI usage from Codex, Gemini CLI, Antigravity, OpenCode, DeepSeek, Claude Code, and Kiro IDE.

The widget renders as a small, transparent, always-on-top window that sits at the edge of your screen. A tray icon hosts the menu bar / system tray controls, and a separate dashboard window exposes detailed connectivity history, AI quota status, and per-collector diagnostics.

## Supported Platforms

- **macOS 11+ (Big Sur)** on **arm64** (Apple Silicon) and **x64** (Intel)
- **Windows 10+** on **x64**

Linux is supported as a development-time target only and is not a release target.

## Installation

### Windows

Download the latest `Monitor Setup <version>.exe` from `release/` and run the installer. The installer is unsigned; SmartScreen may prompt a one-time confirmation on first launch.

### macOS

Download the dmg matching your CPU architecture:

- Apple Silicon (M1 / M2 / M3 / M4): `Monitor-<version>-arm64.dmg`
- Intel: `Monitor-<version>-x64.dmg`

Open the dmg and drag `Monitor.app` into `/Applications`.

## macOS Installation

The macOS distribution is **unsigned** — it ships without an Apple Developer ID signature and without notarization. Gatekeeper will refuse to launch the app on first run with a "无法打开" / "cannot be opened" dialog. Bypass this once with the following gesture:

> 首次运行：右键（Ctrl+click）.app → 打开 → 在弹出的 Gatekeeper 对话框中确认打开

After the first successful launch, macOS remembers the user-confirmed exception and subsequent launches behave like any signed app. Subsequent updates installed by overwriting `Monitor.app` in `/Applications` may require repeating the gesture once.

If you would prefer a signed build, the `electron-builder.yml#mac.identity` field is wired to accept a Developer ID — see `.kiro/specs/macos-platform-support/design.md` for the future opt-in path.

## Development

```bash
npm install
npm run dev          # starts the Electron main + Vite renderer in watch mode
npm run typecheck    # tsc --noEmit for both main and renderer projects
npm test             # vitest run
npm run icons        # regenerate build/icon.{svg,ico,icns,png} and tray assets
```

## Packaging

```bash
npm run package      # Windows: produces release/Monitor Setup <version>.exe
npm run package:mac  # macOS:   produces release/Monitor-<version>-{arm64,x64}.dmg
```

`npm run package:mac` runs the `prepackage:mac` probe first (verifying Xcode Command Line Tools and Python 3.x are installed) and then invokes `electron-builder --mac --x64 --arm64` to emit two arch-specific dmgs.
