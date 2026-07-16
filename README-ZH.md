<div align="center">
  <img src="docs/icon_gb@wh512.png" width="128" height="128" alt="MySekaiStoryteller Logo" />
  <h1>MySekaiStoryteller</h1>
  <p>适用于《Project SEKAI》的 Live2D 同人故事编辑器。</p>

  <p>
    <img src="https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri" />
    <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PixiJS-E91E63?style=for-the-badge&logo=pixiv&logoColor=white" alt="PixiJS" />
  </p>
</div>

[English](README.md) | **简体中文**

## 关于

MySekaiStoryteller 是一款桌面故事编辑器，用剧情片段、Live2D 模型、背景、语音、转场和视觉特效搭出你的故事。

## 功能

- 可视化编排各类剧情片段，支持 Parallel 并行嵌套与拖拽排序
- 支持多游戏的 Live2D 模型，不止于 Project SEKAI
- 支持唇形同步

## 下载

请从 [GitHub Releases](https://github.com/Untitled-Story/MySekaiStoryteller/releases) 下载最新版本。

> 项目目前仍处于 Beta 阶段，升级前记得先备份重要的项目数据。

## 开发

需要 Node.js 22、pnpm 10、Rust，以及 Tauri v2 在对应平台所需的系统依赖。

```bash
pnpm install
pnpm tauri dev
```

常用检查命令：

```bash
pnpm typecheck
pnpm lint
pnpm build
cd src-tauri && cargo check
```

构建原生安装包：

```bash
pnpm tauri build
```

## 项目数据

程序设置保存在系统应用数据目录中；项目则保存在首次启动时选择的工作区，每个项目各自包含故事文件、资源注册表、项目元数据和受管理的资源文件。

## 社区

- Discord：[加入服务器](https://discord.gg/cGWNG6fFdP)
- QQ 群：[753850881](https://qm.qq.com/q/TIFODIZkKk)

## 鸣谢

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
- 每一位参与测试、贡献代码以及使用 MySekaiStoryteller 创作故事的用户

## 支持项目

你可以通过 [爱发电](https://afdian.com/a/devguangchen) 支持项目开发。无论是否捐赠，都感谢你使用它，也感谢你陪它一起变得更好。
