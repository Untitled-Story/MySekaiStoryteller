<div align="center">
  <img src="docs/icon_gb@wh512.png" width="128" height="128" alt="MySekaiStoryteller logo" />
  <h1>MySekaiStoryteller</h1>
  <p>A fan story editor for Project SEKAI — Live2D, voices, effects, and more.</p>

  <p>
    <img src="https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri" />
    <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PixiJS-E91E63?style=for-the-badge&logo=pixiv&logoColor=white" alt="PixiJS" />
  </p>
</div>

**English** | [简体中文](README-ZH.md)

---

MySekaiStoryteller lets you build fan stories using Live2D models, backgrounds, voices, transitions, and visual effects — then preview them in real time. Available on desktop and Android.

> This project is in beta. Back up your project data before upgrading.

## Features

- Compose stories from snippets: dialogue, scene changes, motions, effects, and more
- Live2D support — works with models from multiple games, not just Project SEKAI
- Parallel snippets for running animations simultaneously
- Drag-and-drop snippet ordering
- Lip-sync support
- Real-time preview in the editor; full playback via a dedicated player window

## Download

Get the latest release from [GitHub Releases](https://github.com/Untitled-Story/MySekaiStoryteller/releases).

## Community

- Discord: [Join the server](https://discord.gg/cGWNG6fFdP)
- QQ group: [753850881](https://qm.qq.com/q/TIFODIZkKk)

## Development

Requirements: Node.js 22, pnpm 10, Rust, and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
pnpm install
pnpm tauri dev
```

Common checks:

```bash
pnpm typecheck
pnpm lint
pnpm build
cd src-tauri && cargo check
```

Build native installers:

```bash
pnpm tauri build
```

### Android

Requires Android SDK/NDK, JDK, and the Rust Android targets.

```bash
# First-time setup (skip if gen/android already exists)
pnpm android:init

# Run on a device or emulator
pnpm android:dev

# Production APK/AAB
pnpm tauri android build --apk --target aarch64
```

Notes:

- The first build downloads Gradle and Android dependencies from the official Google Maven and Maven Central repositories. On restricted networks, set `MSS_USE_ALIYUN_MAVEN=true` to opt into the Aliyun Maven mirrors.
- Navigation is handled in-app via `#/editor/:project` and `#/player/:project` — no multi-window.
- The player uses automatic timeline playback, no tap-to-advance.
- To preview the mobile shell in a desktop browser: `localStorage.setItem('mss.mobileShell','1')` or append `?mobileShell=1`.

## Acknowledgements

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
- Everyone who tests, contributes, and creates stories with MySekaiStoryteller

## Support

If you'd like to support development, you can do so on [Afdian](https://afdian.com/a/devguangchen). Either way, thanks for being here.
