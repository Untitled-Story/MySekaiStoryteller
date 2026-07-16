<div align="center">
  <img src="docs/icon_gb@wh512.png" width="128" height="128" alt="MySekaiStoryteller logo" />
  <h1>MySekaiStoryteller</h1>
  <p>A fan-made story editor for Project SEKAI with Live2D playback.</p>

  <p>
    <img src="https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri" />
    <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PixiJS-E91E63?style=for-the-badge&logo=pixiv&logoColor=white" alt="PixiJS" />
  </p>
</div>

**English** | [简体中文](README-ZH.md)

## About

MySekaiStoryteller is a desktop editor for building stories out of snippets, Live2D models, backgrounds, voices, transitions, and visual effects.

## Features

- Visual story editing with nested Parallel snippets and drag-and-drop ordering
- Live2D models from multiple games, not just Project SEKAI
- Lip-sync support

## Download

Download the latest build from [GitHub Releases](https://github.com/Untitled-Story/MySekaiStoryteller/releases).

> This project is still in beta, so please back up important project data before upgrading.

## Development

Requirements: Node.js 22, pnpm 10, Rust, and the platform dependencies required by Tauri v2.

```bash
pnpm install
pnpm tauri dev
```

Useful checks:

```bash
pnpm typecheck
pnpm lint
pnpm build
cd src-tauri && cargo check
```

Build native bundles with:

```bash
pnpm tauri build
```

## Project Data

Settings live in the system application-data directory. Projects live in the workspace you choose on first launch, and each one holds its own story, asset registry, metadata, and managed files.

## Community

- Discord: [Join the server](https://discord.gg/cGWNG6fFdP)
- QQ group: [753850881](https://qm.qq.com/q/TIFODIZkKk)

## Acknowledgements

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
- Everyone who tests, contributes to, and creates stories with MySekaiStoryteller

## Support

You can support development through [Afdian](https://afdian.com/a/devguangchen). Donation or not, thanks for using the project and helping it grow.
