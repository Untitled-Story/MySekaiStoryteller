# 变更说明：4K 导出管线优化（2026-11）

本文档汇总本轮针对 4K 视频导出管线的全部代码变更、依据与验证方式，便于审阅与回滚。

## 1. 变更清单

| 文件                                     | 变更                                                                                                                                                                                 | 目的                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/export/glNv12Packer.ts`             | 新增平面式 YUV444 打包路径（`yuv444p`）+ 三平面绘制；通用信箱着色器参数化色度垂直步长                                                                                                | GPU 直出 YUV444，免除后端 RGBA→YUV 全分辨率转换；修掉竖屏导出时 4:2:2 被静默降级为 4:2:0 |
| `src/export/types.ts`                    | 新增 `RenderQuality`、`ChromaMode`；`VideoExportConfig.renderQuality?`                                                                                                               | 提供"速度/均衡/质量"三档开关                                                             |
| `src/export/presets.ts`                  | 新增 `resolveChromaMode()`：按编码器承载能力把档位解析为 4:2:0 / 4:2:2 / 4:4:4                                                                                                       | H.264/HEVC/VP9/AV1 只输出 4:2:0，喂更高色度纯属浪费                                      |
| `src/export/ffmpegBackend.ts`            | IPC 批次与 PBO 批次解耦；允许 3 批在飞（4 缓冲区）；重复帧复用接线                                                                                                                   | 减少 IPC 往返次数、重叠打包与传输、静止画面零传输                                        |
| `src/export/exportApi.ts`                | `repeatVideoBatch` / `pushVideoDelta`；ffmpeg 能力探测按路径缓存（TTL 5 分钟）                                                                                                       | 重复帧复用、增量接收端、消除每次导出 80~112 ms 的子进程探测                              |
| `src-tauri/src/commands/video_export.rs` | `last_batch`/`delta_frame`/`last_batch_frames` 字段；`Arc<Vec<u8>>` 帧管道；`export_repeat_video_batch`；`export_push_video_delta` + `apply_delta_payload`；`yuv444p` 支持；新增单测 | 后端重复写入、增量补丁、4:4:4 平面输入                                                   |
| `src-tauri/src/lib.rs`                   | 注册 `export_repeat_video_batch`、`export_push_video_delta`                                                                                                                          | 命令暴露                                                                                 |
| `src-tauri/src/protocol.rs`              | 新增仅 debug 生效的 `mss://.../__bench_upload` 端点                                                                                                                                  | 通道吞吐基准（已被否决，见第 4 节）                                                      |
| `src/components/VideoExportDialog.tsx`   | 导出对话框新增"渲染质量"下拉；透明通道/非 ProRes 时置灰并说明原因                                                                                                                    | 用户可感知的档位选择                                                                     |
| 四个 i18n locale                         | 新增 7 个键（含档位名称、提示、两种锁定说明）                                                                                                                                        | 四语同步                                                                                 |
| `.agents/docs/*`                         | 性能台账与方案矩阵                                                                                                                                                                   | 交接与证据留档                                                                           |

## 2. 关键数据

### 像素格式与档位（4K ProRes，真实管线）

| 档位     | 输入格式          | 每帧         | 端到端               |
| -------- | ----------------- | ------------ | -------------------- |
| speed    | nv12 4:2:0        | 11.87 MB     | 约 74 fps            |
| balanced | nv16 4:2:2        | 15.82 MB     | 约 56~83 fps（波动） |
| quality  | **yuv444p 4:4:4** | **23.73 MB** | **约 52 fps**        |

质量档相对旧 RGBA 路径：每帧字节 −25%，输出文件 −7%（不再写无用 alpha），色度仍为 4:4:4 无损。

### 已否决的尝试

| 尝试                       | 否决依据                                                   |
| -------------------------- | ---------------------------------------------------------- |
| 自定义 URI 协议替代 invoke | 8 MB 更慢、32 MB 仅 +8%                                    |
| SharedArrayBuffer 零拷贝   | WKWebView 不提供（`crossOriginIsolated: false`）           |
| 块级增量传输               | JS 比对 95 MB 需 128 ms，而省下的传输仅 32 ms → 净亏 96 ms |
| 加大流水线深度             | 深度 2/3/4 → 50.1/51.8/52.1 fps，差异在噪声内              |

## 3. 验证方式

| 项            | 命令 / 手段                      | 结果                                                                    |
| ------------- | -------------------------------- | ----------------------------------------------------------------------- |
| 前端类型      | `pnpm typecheck`                 | 通过                                                                    |
| Rust 编译     | `cargo check`                    | 通过                                                                    |
| Rust 单测     | `cargo test --lib video_export`  | **10/10 通过**                                                          |
| YUV444 正确性 | 应用内对照 BT.709 理论值逐点校验 | Y 63/32、U 102/240、V 240/118，全部吻合                                 |
| 输出格式      | `ffprobe`                        | quality: `4444 / yuv444p12le`；speed/balanced: `Standard / yuv422p10le` |
| 对话框交互    | 应用内自动化断言 DOM             | 默认置灰显示 speed、切 ProRes 解锁默认 quality、透明通道下锁定并提示    |

## 4. 保留但当前未接线的能力

`export_push_video_delta` 与 `apply_delta_payload` 已实现且通过 10 类畸形载荷测试，
但**前端不下发增量载荷**——因为 JS 侧比对成本（0.78 GB/s）远高于传输（3 GB/s），
该路径必然亏损。

保留原因：它是"GPU 生成变化掩码"方案落地时的现成接收端，且已具备完整的输入校验。
若长期不打算做 GPU 掩码，可安全删除（本文件即为删除依据）。

## 5. 回滚指引

- 仅回退档位功能：还原 `types.ts` / `presets.ts` / `VideoExportDialog.tsx` / 四个 locale，
  并把 `ffmpegBackend.ts` 的 `chromaMode` 改回按 `videoCodec === 'prores'` 判断
- 仅回退 YUV444：`resolveChromaMode` 的 `quality` 分支改回 `'444'`
- 回退后端能力：移除 `video_export.rs` 三个新命令与相关字段，并从 `lib.rs` 取消注册

## 6. 已知局限

1. 测量环境需应用窗口在前台；后台时 WKWebView 会节流，导致帧率数据失真
2. 会话中**第一次**导出比后续慢约 2.7 倍（编码器进程冷启动），未深挖
3. balanced 档与 speed 档在真实管线下速度相当，先前"nv16 更快"的结论未能复现
