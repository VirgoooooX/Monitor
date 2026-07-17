> [!IMPORTANT]
> **Vibe Coding 说明 / Disclaimer**
>
> 本仓库是作者在 AI 辅助下以 **vibe coding** 方式完成的个人作品：主要通过自然语言描述需求、由 AI 生成和修改代码，作者负责产品想法、体验验证和方向取舍。作者不是专业开发者，也不具备系统的代码审计能力；代码按现状提供，请在使用、部署或二次开发前自行审查、测试并承担相应风险。

<div align="center">

<img src="build/icon.png" alt="Monitor logo" width="128" height="128" />

# Monitor

**A floating-widget desktop monitor for OpenClash connectivity and AI usage.**

<sub>Cross-platform · Electron 33 · Better-SQLite3 · React 18 · Property-tested · i18n (en-US / zh-CN)</sub>

[Features](#features) · [Gallery](#gallery) · [Supported Platforms](#supported-platforms) · [Installation](#installation) · [Themes](#themes) · [Development](#development) · [Packaging](#packaging) · [Architecture](#architecture)

[中文文档](README.zh-CN.md)

</div>


---

## Gallery

<div align="center">
  <img src="assets/expend%20Windows.png" alt="Expanded dashboard" width="780" />
  <br/>
  <sub><b>Expanded dashboard</b> — connectivity history, AI quota, per-collector diagnostics</sub>
</div>

<br/>

<div align="center">
  <img src="assets/compact%20windows.png" alt="Compact widget" height="480" />
  &nbsp;&nbsp;&nbsp;
  <img src="assets/mini%20Windows.png" alt="Mini rail" height="480" />
  <br/>
  <sub><b>Compact widget</b> (left) — always-on-top, transparent, draggable &nbsp;·&nbsp; <b>Mini rail</b> (right) — collapses to a single edge strip</sub>
</div>

## Features

| | |
|---|---|
| 🌐 **OpenClash live status** | Continuous probe of the controller, current node, latency sparklines, and node-group health. Hide-instead-of-quit tray, Spaces-aware floating widget on macOS. |
| 🧠 **AI usage aggregation** | Per-account quota and token counters for Codex, Gemini CLI, Antigravity, OpenCode, DeepSeek, Claude Code, Kiro IDE, Xiaomi MiMo, Gemini API, and OpenAI-compatible services — credentials encrypted at rest via Keychain (macOS) / DPAPI (Windows). |
| 🌍 **Bilingual UI (en-US / zh-CN)** | Full internationalization with live language switching — no restart required. OS locale auto-detected on first launch; user choice persisted across sessions. Covers all renderer surfaces, tray menu, and native dialogs. |
| 🪟 **Always-on-top widget** | Transparent, frameless, draggable. On macOS the widget floats above full-screen Spaces (`screen-saver` level) and `LSUIElement = true` keeps it out of the Dock and Cmd+Tab. |
| 📊 **Expanded dashboard** | Network quick actions (node switching + config switching), connectivity history, AI quota, per-collector capability, and a redacted diagnostics export bundle for support tickets. |
| 🔐 **Secrets stay local** | All secret values flow through `safeStorage`. The diagnostics export is value-redacted and runs through a property-based "no-leak" sieve covering 100+ generated cases per platform. |
| 🧪 **Spec-driven, property-tested** | 530 tests pass on every commit, including ~13 fast-check property suites that exercise per-platform path resolution, atomic build artefacts, and lifecycle invariants. |

### Network panel

<div align="center">
  <img src="assets/network.png" alt="Network panel" width="780" />
  <br/>
  <sub>Per-node connectivity history with latency sparklines and consecutive-failure tracking</sub>
</div>

### Monthly usage

<div align="center">
  <img src="assets/monthly.png" alt="Monthly usage" width="780" />
  <br/>
  <sub>Token-budget rollups across every imported AI provider</sub>
</div>

## Themes

The compact widget ships with a curated theme system — switch the look from the expanded settings panel without restarting.

<div align="center">
  <img src="assets/themes.png" alt="Theme picker" height="420" />
  &nbsp;&nbsp;&nbsp;
  <img src="assets/more%20themes.png" alt="More themes" height="420" />
  <br/>
  <sub><b>Theme picker</b> (left) &nbsp;·&nbsp; <b>More themes</b> (right) — eleven presets across glassy, neumorph, paper, and OLED families</sub>
</div>

Available presets: `liquid-glass`, `material-you`, `soft-neumorph`, `paper-dashboard`, `mint-monitor` (default), `device-oled`, `obsidian-glass`, `aurora-ring`, `holo-grid`, `liquid-metal`, `signal-pulse`.

## Supported Platforms

| OS | Architectures | Minimum version | Distribution |
|---|---|---|---|
| 🍎 **macOS 11+** (Big Sur) | `arm64` (Apple Silicon) · `x64` (Intel) | 11.0 | Two arch-specific dmgs |
| 🪟 **Windows 10+** | `x64` | 10.0.19041 | NSIS installer (`Monitor Setup <version>.exe`) |
| 🐧 Linux | `x64` | — | Development-time only, not a release target |

The macOS build uses Hardened Runtime entitlements (`com.apple.security.cs.allow-jit` + `allow-unsigned-executable-memory`) so a future opt-in to Developer ID signing requires no entitlements change.

## Installation

### Windows

1. Download the latest `Monitor Setup <version>.exe` from `release/`.
2. Run the installer. SmartScreen may prompt a one-time confirmation because the binary is unsigned.
3. The widget launches into the system tray; right-click for the menu.

### macOS

1. Download the dmg matching your CPU:
   - Apple Silicon (M1 · M2 · M3 · M4): `Monitor-<version>-arm64.dmg`
   - Intel: `Monitor-<version>-x64.dmg`
2. Open the dmg and drag `Monitor.app` into `/Applications`.
3. Follow the [Gatekeeper bypass](#macos-installation) below on first launch.

## macOS Installation

The macOS distribution is **unsigned** — it ships without an Apple Developer ID signature and without notarization. Gatekeeper will refuse to launch the app on first run with a "无法打开" / "cannot be opened" dialog. Bypass this once with the following gesture:

> First launch: right-click (Ctrl+click) `Monitor.app` → Open → confirm in the Gatekeeper dialog
>
> (Verbatim Chinese: 首次运行：右键（Ctrl+click）.app → 打开 → 在弹出的 Gatekeeper 对话框中确认打开)

After the first successful launch macOS remembers the user-confirmed exception and subsequent launches behave like any signed app. Replacing `Monitor.app` in `/Applications` during an update may require repeating the gesture once.

If you would prefer a signed build, the `electron-builder.yml#mac.identity` field is wired to accept a Developer ID and the entitlements file is already in place — see `.kiro/specs/macos-platform-support/design.md` for the future opt-in path.

### macOS posture at a glance

| Behaviour | Source | Why |
|---|---|---|
| `LSUIElement = true` | `electron-builder.yml#mac.extendInfo` | No Dock icon, no Cmd+Tab entry — reads as a menu-bar accessory |
| `setAlwaysOnTop(true, 'screen-saver')` | `src/main/windows.ts` | Floats above full-screen apps |
| `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` | `src/main/windows.ts` | Stays visible across Spaces |
| Template tray icon | `build/tray-iconTemplate.png` (24×24) + `@2x.png` (48×48) | Recolours with menu-bar tint via `setTemplateImage(true)` |
| Login Items registration | `app.setLoginItemSettings({ openAtLogin })` | Cross-platform autostart, no `process.platform` branching |

## Development

```bash
npm install
npm run dev          # Electron main + Vite renderer in watch mode
npm run typecheck    # i18n catalog validation + tsc --noEmit for both main and renderer projects
npm test             # vitest run — 530 tests, ~11s
npm run icons        # regenerate build/icon.{svg,ico,icns,png} + tray assets
```

The repo follows a **spec-driven** workflow under `.kiro/specs/`. Each feature directory contains `requirements.md`, `design.md`, and `tasks.md`; property-based tests live alongside their implementation as `*.pbt.test.ts` files.

### i18n

The codebase is fully internationalized with a shared `src/i18n/` runtime consumed by both the main process and the renderer. Translation catalogs (`zh-CN` and `en-US`) are statically compiled into the bundle — no runtime fetching. A build-time validator (`scripts/validate-i18n-catalogs.mjs`) enforces catalog symmetry, value invariants, and CJK-untranslated rules at every build.

```bash
npm run i18n:validate         # validate catalog key symmetry + value invariants
npm run i18n:validate:bundle  # validate compiled bundle byte-equality (post-build)
```

## Packaging

```bash
# Windows host
npm run package      # → release/Monitor Setup <version>.exe

# macOS host
npm run package:mac  # → release/Monitor-<version>-arm64.dmg
                     # → release/Monitor-<version>-x64.dmg
```

`npm run package:mac` runs the `prepackage:mac` probe first — it verifies Xcode Command Line Tools (`xcode-select -p`) and Python 3.x are installed, and unlinks any stale `better_sqlite3.node` whose Mach-O / PE-COFF magic bytes do not match the current target. Both steps must exit 0 before `electron-builder --mac --x64 --arm64` runs, so a missing prerequisite never produces a broken dmg.

### Heavy integration tests

Two opt-in integration tests exercise the real build:

```bash
# Windows
RUN_PACKAGING_INTEGRATION=1 npx vitest run tests/integration/package-win.integration.test.ts

# macOS
RUN_PACKAGING_INTEGRATION=1 npx vitest run tests/integration/package-mac.integration.test.ts
```

They are skipped under a normal `npm test` so the suite stays fast.

### Releasing

Releases go through [GitHub Actions](.github/workflows/release.yml) with two trigger modes:

- **Tag push** (`v*.*.*`): parallel builds on Windows + macOS runners, then a GitHub Release with dmg / exe / blockmap / `latest*.yml` attached automatically.
- **Manual** (`workflow_dispatch`): dual-platform smoke build, artefacts uploaded to the run only — no Release created. Useful for regression testing after dependency upgrades.

Example release of `v0.2.0`:

```bash
npm version 0.2.0 -m "Release v%s"
git push origin main --follow-tags
```

The macOS job runs on `macos-14` (Apple Silicon), producing both `arm64` and `x64` dmgs in one pass; the Windows job runs on `windows-latest`, outputting the NSIS installer.

## Architecture

```mermaid
flowchart LR
  subgraph Main["Main process (Electron)"]
    APP[app.ts<br/>boot · lifecycle]
    SCHED[Scheduler<br/>chained setTimeout]
    PATHS[platform/paths.ts<br/>per-platform resolvers]
    SECRETS[security/secrets.ts<br/>safeStorage wrapper]
    DIAG[services/diagnostics<br/>redaction sieve]
    I18N[i18n<br/>shared catalogs + runtime]
  end

  subgraph Collectors["Collectors"]
    NET[network · openclash<br/>nodeScan · usage]
    AI[Codex · Gemini · Antigravity<br/>OpenCode · Claude · Kiro<br/>DeepSeek · Xiaomi · Gemini API]
  end

  subgraph Store["SQLite store (better-sqlite3)"]
    DB[(monitor.db)]
    MIGS[migrations]
  end

  subgraph Render["Renderer (React 18 + Vite)"]
    COMPACT[Compact widget<br/>always-on-top]
    EXPANDED[Expanded dashboard]
  end

  APP --> SCHED
  APP --> SECRETS
  APP --> DIAG
  APP --> I18N
  SCHED --> NET
  SCHED --> AI
  PATHS --> AI
  NET --> DB
  AI --> DB
  MIGS --> DB
  APP --> Render
  I18N --> Render
  DIAG --> EXPANDED
  SECRETS -. encrypts .-> DB
```

### Tech stack

- **Electron 33** with Hardened Runtime entitlements
- **React 18 + Vite 5** for the renderer; `contextIsolation: true`, `sandbox: true`, hardened CSP
- **better-sqlite3 11** for the local store with versioned migrations
- **Zod** for IPC and settings schemas; the strict schemas back the renderer↔main contract
- **fast-check 3** for property-based testing
- **electron-builder 25** with two arch-specific dmgs and a single NSIS installer

### Supported AI providers

| Provider | Capability | Credential Source |
|---|---|---|
| Codex (ChatGPT) | Official quota | Auth file import |
| Gemini CLI | Official quota | Auth file import |
| Antigravity | Official quota | Auth file import |
| Claude Code | Official quota | Auth file import |
| Kiro IDE | Official quota (with auto token refresh) | Auth file import |
| OpenCode Go | Official quota | Manual (auth cookie + workspace URL) |
| DeepSeek | Official quota (multi-wallet + daily usage) | Manual API key (+ optional userToken) |
| Xiaomi MiMo | Official quota | Manual (passToken + userId) |
| Gemini API | Health check only | Manual API key |
| OpenAI-compatible | Health check only | Manual API key + base URL |

## Spec workflow

Every feature in this repo lands as a spec triple under `.kiro/specs/<feature-name>/`:

```
.kiro/specs/
├── codebase-refactor-and-ui-uplift/
├── compact-theme-system/
├── cpa-quota-import/
├── desktop-monitor-widget/
├── i18n-multilingual-support/       ← latest landed feature
│   ├── requirements.md            # EARS-formatted acceptance criteria
│   ├── design.md                  # implementation plan + correctness properties
│   └── tasks.md                   # 18 task groups, dependency-graphed
├── macos-platform-support/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
└── network-quick-actions/
```

## License

Personal-use software; not currently distributed under an open-source license.
