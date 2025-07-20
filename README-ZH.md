<!--suppress HtmlDeprecatedAttribute -->
<div align="center" style="text-align: center; margin-top: 10px;">
 <img src="documents/assets/logo.png" style="align-self: center; width: 150px; margin-bottom: 0;" alt="Logo" />
 <h3 style="margin-top: 0; text-align: center;">My Sekai Storyteller</h3>
 <p style="text-align: center;">一个采用 Project SEKAI 风格的 Live2d 阅读工具</p>
 <div style="display: flex; justify-content: center;">
  <img src="documents/assets/live2d-badge.svg" alt="Live2D Badge" style="margin-top: 0; margin-right: 5px;"/>
  <img src="https://img.shields.io/badge/typescript-20B2AA?logoColor=ffffff&style=for-the-badge&logo=typescript" alt="TypeScript" style="margin-top: 0; margin-right: 5px;" />
  <img src="https://img.shields.io/badge/electron-20B2AA?style=for-the-badge&logoColor=white&logo=electron" alt="Electron" style="margin-top: 0;" />
 </div>
</div>

> [!IMPORTANT]
> 项目正在持续开发中。因此，暂不提供二进制文件。

[**English**](README.md) | **简体中文 (当前)**

## 使用

本项目通过 `*.sekai-story.json` 读取故事信息。并从 `*.sekai-story.json` 的所在目录下读取定义的文件。

请参阅 [Wiki](https://github.com/GuangChen2333/MySekaiStoryteller/wiki/%E4%B8%BB%E9%A1%B5) 获取更多信息与教程。

## 协议

由本项目产出、录制的视频内容遵循 [MySekaiStoryteller 视频使用、分发许可协议](VIDEO-LICENSE-CN.md)。

本项目源代码遵循 [GNU GPLv3](LICENSE) 协议。

在 [RedistributableFiles.txt](src/renderer/RedistributableFiles.txt) 定义中的组件遵循
[Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
协议。

## 支持的 Snippet

- [x] ChangeLayoutMode
- [x] ChangeBackgroundImage
- [x] LayoutAppear
- [x] LayoutClear
- [x] Talk
- [x] HideTalk
- [x] Motion
- [x] Move
- [x] Telop
- [x] BlackIn
- [x] BlackOut

其他 Snippet 将在未来被添加。

## 技术栈

- [Electron](https://www.electronjs.org/)
- [PixiJS](https://pixijs.com/)
- [pixi-live2d-display-advanced](https://github.com/GuangChen2333/pixi-live2d-display-advanced)

## 鸣谢

- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
