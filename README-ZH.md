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

---

用 Live2D 模型、背景、语音、转场和视觉特效，拼出你想讲的故事，并实时预览效果。支持桌面端和 Android。

> 项目目前仍处于 Beta 阶段，升级前记得先备份重要的项目数据。

## 功能

- 用片段搭故事：对话、场景切换、动作、特效……想加什么加什么
- 支持多款游戏的 Live2D 模型，不只是 Project SEKAI
- 支持 Parallel 并行片段，让多个动画同时进行
- 拖拽调整片段顺序
- 支持唇形同步
- 编辑器内实时预览；独立播放器窗口完整放映

## 下载

从 [GitHub Releases](https://github.com/Untitled-Story/MySekaiStoryteller/releases) 下载最新版本。

## 社区

- Discord：[加入服务器](https://discord.gg/cGWNG6fFdP)
- QQ 群：[753850881](https://qm.qq.com/q/TIFODIZkKk)

## 开发

需要 Node.js 22、pnpm 10、Rust，以及 [Tauri v2 对应平台的系统依赖](https://v2.tauri.app/start/prerequisites/)。

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

### Android

额外需要 Android SDK / NDK、JDK，以及对应 Rust Android targets。

```bash
# 首次初始化 Android 工程（已有 gen/android 时跳过）
pnpm android:init

# 连接设备或模拟器后运行
pnpm android:dev

# 生产构建 APK/AAB
pnpm tauri android build --apk --target aarch64
```

说明：

- 首次构建会下载 Gradle 及 Android 依赖。国内网络可走本地代理，或使用已配置好的阿里云 Maven 镜像（`src-tauri/gen/android/build.gradle.kts`）。
- 导航在 WebView 内进行，路由到 `#/editor/:project` 和 `#/player/:project`，不开多窗口。
- 播放器自动推进时序，没有点击翻页。
- 本地预览移动端样式：在浏览器控制台执行 `localStorage.setItem('mss.mobileShell','1')`，或 URL 加 `?mobileShell=1`。

## 鸣谢

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
- 每一位参与测试、贡献代码，以及用它讲出自己故事的人

## 支持项目

可以通过 [爱发电](https://afdian.com/a/devguangchen) 支持开发。当然，不打赏也没关系——感谢你用它，感谢你陪它一起变好。
