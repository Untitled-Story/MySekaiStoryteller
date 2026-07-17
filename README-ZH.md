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

MySekaiStoryteller 是一款故事编辑器，用剧情片段、Live2D 模型、背景、语音、转场和视觉特效搭出你的故事。桌面端为多窗口工作流；Android 端采用单 WebView 内路由，并提供手机/平板响应式布局。

## 功能

- 可视化编排各类剧情片段，支持 Parallel 并行嵌套与拖拽排序
- 支持多游戏的 Live2D 模型，不止于 Project SEKAI
- 支持唇形同步
- Android 优先的移动端布局：手机竖屏「上预览 + 下双 Tab（大纲/属性）」，平板接近桌面并做触控优化

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

### Android（优先支持，iOS 后置）

额外需要 Android SDK / NDK、JDK，以及对应 Rust Android targets。

```bash
# 首次初始化 Android 工程（仓库已包含 gen/android 时可跳过）
pnpm android:init

# 连接设备或模拟器后开发
pnpm android:dev

# 生产构建 APK/AAB（可指定 ABI，例如仅 arm64）
pnpm tauri android build --apk --target aarch64
```

> 首次构建会下载 Gradle 发行包与 Android 依赖。国内网络可走本地代理下载 Gradle，或使用阿里云 Maven 镜像（`src-tauri/gen/android/build.gradle.kts` 已配置）。若 Java HTTPS 经 HTTP 代理握手失败，可改用 SOCKS/直连镜像。Rust 侧 `aarch64-linux-android` release 与前端 typecheck/lint 应先通过。

移动端说明：

- 导航：在同一 WebView 内路由到 `#/editor/:project`、`#/player/:project`（不再开多窗口）
- 工作区：默认使用应用私有目录；资源导入仍走系统文件选择器
- 播放器：保持与桌面一致的自动播放时序，**没有**点屏推进
- 本地可用 `localStorage.setItem('mss.mobileShell','1')` 或 `?mobileShell=1` 在桌面浏览器预览移动壳

## 项目数据

程序设置保存在系统应用数据目录中；桌面端项目保存在首次启动时选择的工作区，Android 默认使用应用私有目录。每个项目各自包含故事文件、资源注册表、项目元数据和受管理的资源文件。

## 社区

- Discord：[加入服务器](https://discord.gg/cGWNG6fFdP)
- QQ 群：[753850881](https://qm.qq.com/q/TIFODIZkKk)

## 鸣谢

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
- 每一位参与测试、贡献代码以及使用 MySekaiStoryteller 创作故事的用户

## 支持项目

你可以通过 [爱发电](https://afdian.com/a/devguangchen) 支持项目开发。无论是否捐赠，都感谢你使用它，也感谢你陪它一起变得更好。
