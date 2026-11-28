# 4K 导出性能分析与优化台账

> 本文档记录 4K 视频导出链路的实测数据、瓶颈定位与优化方案。
> 所有数字均标注测量方式与可信度，推算项明确标注。

## 1. 测试设备

| 项目    | 值                              |
| ------- | ------------------------------- |
| 机型    | Mac mini (Mac16,11)             |
| 芯片    | Apple M4 Pro                    |
| CPU     | 12 核（8 性能 + 4 能效）        |
| GPU     | 16 核                           |
| 内存    | 48 GB 统一内存                  |
| 系统    | macOS 27.2 (26B123)             |
| 显示    | 4096×2560 @144Hz                |
| ffmpeg  | 9.0.2（含 videotoolbox）        |
| WebView | WKWebView（Tauri macOS 运行时） |

## 2. 导出链路与测量方法

链路：Pixi/WebGL 渲染 → GlFramePacker（GPU 内转 YUV + PBO 异步回读）→ JS 批次缓冲 → Tauri IPC → Rust → ffmpeg stdin → 编码器 → 落盘。

测量手段（按可信度从高到低）：

1. **应用内实测**：通过 `tauri-plugin-webdriver-automation`（debug + macOS 注册，见 `src-tauri/src/lib.rs`）在真实运行的 Tauri webview 中执行 JS，直接调用生产代码 `GlFramePacker` / `exportApi` 完成真实导出，并用 `ffprobe` 校验输出。**这是唯一反映真实链路的测量方式。**
2. **独立 ffmpeg 基准**：`-f null -` 输出，测量编码器吞吐。
3. **浏览器 WebGL2 基准**：测量读回带宽上限（注意：Chromium 与 WKWebView 结果差异较大，不可混用）。

## 3. 分段能力（4K 3840×2160）

| 阶段                             | 实测              | 测量方式          |
| -------------------------------- | ----------------- | ----------------- |
| 纯渲染（轻量着色器，fence 同步） | 1446 fps          | 浏览器基准        |
| 纯渲染（8 次 ALU，fence 同步）   | 543 fps           | 浏览器基准        |
| GPU 读回 NV12（12.44 MB/帧）     | 295.6 / 307.7 fps | 应用内生产 packer |
| GPU 读回 NV16（16.59 MB/帧）     | 未单独测          | —                 |
| GPU 读回 RGBA（33.18 MB/帧）     | 110.7 / 119.5 fps | 应用内生产 packer |
| 编码 h264 VideoToolbox           | 55.6 fps          | ffmpeg 基准       |
| 编码 hevc VideoToolbox           | 54.0 fps          | ffmpeg 基准       |
| 编码 ProRes 422                  | 137.1 fps         | ffmpeg 基准       |
| 编码 ProRes 4444（yuv444p10le）  | 135.5 fps         | ffmpeg 基准       |
| 编码 ProRes 4444（yuva444p10le） | 70.1 fps          | ffmpeg 基准       |
| IPC 传输（11.87 MB/批）          | 1480 MB/s         | 应用内 pushMs     |
| IPC 传输（31.64 MB/批）          | 908 MB/s          | 应用内 pushMs     |

## 4. 端到端实测（应用内，40 帧 4K ProRes）

| 档位    | 像素格式 | 每帧字节 | packMs  | pushMs  | 总计    | 端到端       |
| ------- | -------- | -------- | ------- | ------- | ------- | ------------ |
| speed   | nv12     | 11.87 MB | 205 ms  | 353 ms  | 627 ms  | **63.8 fps** |
| quality | rgba     | 33.18 MB | 1954 ms | 1534 ms | 2573 ms | **15.5 fps** |

关键事实：`packMs` 窗口内包含 `onWritten` 回调中的 `await pushVideoBatch`，因此 packMs 与 pushMs 高度重叠。扣除后真实耗时结构约为：

- quality 档：pack ≈ 8 ms/帧，IPC ≈ 38 ms/帧 → **IPC 占 ~80%**
- speed 档：pack ≈ 5 ms/帧，IPC ≈ 9 ms/帧 → IPC 占 ~56%

**结论：IPC 传输是当前架构的第一瓶颈，色度格式是第二瓶颈。**

## 5. 已定位的具体低效点

### 5.1 `batchGroupFrames` 对 RGBA 退化为 1

`computeOptimalPboGroupFrames`（`src/export/glNv12Packer.ts`）按 `PBO_GROUP_BUDGET_BYTES = 50 MB` 分组：

- nv12（11.87 MB）→ 4 帧/批，单次 IPC 47.5 MB
- **rgba（33.18 MB）→ 1 帧/批，单次 IPC 33.18 MB**

实测证据：4K RGBA 40 帧产生 **44 次 IPC 往返**，而 NV12 仅 11 次。

实测影响：把批次从 1 帧放大到 4 帧，IPC 吞吐 **856 → 1238 MB/s（+45%）**。

### 5.2 IPC 批次强制单批在飞

`src/export/ffmpegBackend.ts` 的 `handleBatchWritten → dispatchActiveBatch → awaitInFlightPush()` 在每次提交前等待上一批完成，导致"打包"与"传输"无法重叠：

```
当前：pack(8ms) → push(38ms) → pack(8ms) → push(38ms) ...   串行
理想：pack(8ms) 与 push(38ms) 重叠 → 帧耗时 ≈ 38ms 而非 46ms
```

### 5.3 Rust 侧每批完整克隆

`src-tauri/src/commands/video_export.rs` 的 `extract_raw_body`：

```rust
InvokeBody::Raw(bytes) => Ok(bytes.clone()),
```

每个 33 MB 批次多做一次完整 memcpy（约 3 ms）。虽不及 IPC 本体开销，但属可消除的冗余。

### 5.4 编码器选择与实际负载不匹配

- h264/hevc VideoToolbox 在 4K 下吞吐仅 55 fps，**慢于软件 libx264 veryfast（98 fps）**
- ProRes 4444 硬编 135~158 fps，远高于 IPC 能力，因此 ProRes 路径的瓶颈完全在 IPC 而非编码

## 6. 优化方案清单（按预期收益排序）

| 编号 | 方案                                             | 预期收益                       | 风险                     | 状态           |
| ---- | ------------------------------------------------ | ------------------------------ | ------------------------ | -------------- |
| O1   | 解耦 IPC 批次与 PBO 批次，让 RGBA 也能多帧凑批   | IPC +45%，端到端 +20~30%       | 低（纯前端）             | 待实施         |
| O2   | 允许 2~3 批在飞，重叠打包与传输                  | 端到端 +30~50%                 | 低（纯前端）             | 待实施         |
| O3   | Rust 侧消除每批 clone                            | 每批省 ~3 ms                   | 中（需权衡借用生命周期） | 待实施         |
| O4   | 提高 `PBO_GROUP_BUDGET_BYTES`                    | 间接改善 O1                    | 低                       | 与 O1 合并考虑 |
| O5   | 共享内存 / 落盘中转，绕开逐批 IPC                | 最大（可抹掉 80% 的 IPC 时间） | 高（跨语言契约）         | 备选           |
| O6   | 渲染搬到 Rust 原生 Metal，编码器直吃 GPU surface | 可回到千帧量级                 | 极高（重写渲染层）       | 长期           |

## 7. 已完成的优化

| 改动                                                       | 效果                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| ProRes 路径强制 RGBA + `prores_videotoolbox -profile 4444` | 色度从 4:2:0 双重降采样变为无损          |
| 新增 `renderQuality` 三档（speed/balanced/quality）        | 用户可在 4:2:0 / 4:2:2 / 4:4:4 间取舍    |
| 通用信箱着色器参数化色度垂直步长                           | 竖屏导出时 balanced 不再静默降级为 4:2:0 |

## 8. 色度质量基线（逐平面 PSNR）

4K 合成测试图（`testsrc2` + 高饱和色块），以全色度 `yuv444p` 为参考：

| 格式  | Y     | U     | V     | 平均     |
| ----- | ----- | ----- | ----- | -------- |
| 4:2:0 | 43.35 | 40.14 | 35.95 | 38.78 dB |
| 4:2:2 | 44.39 | 41.97 | 38.33 | 40.85 dB |
| 4:4:4 | inf   | inf   | inf   | 无损     |

应用内实测（对抗性测试图，24 条 3px 高饱和彩线）：

| 场景           | 档位     | Y     | U     | V     | 平均  |
| -------------- | -------- | ----- | ----- | ----- | ----- |
| 满舞台 4K      | speed    | 26.42 | 30.92 | 34.10 | 29.35 |
| 满舞台 4K      | balanced | 26.42 | 30.99 | 39.36 | 29.73 |
| 信箱 1080×1920 | speed    | 30.50 | 33.90 | 26.18 | 29.08 |
| 信箱 1080×1920 | balanced | 30.44 | 35.49 | 38.99 | 33.59 |

## 9. 复现方式

```bash
# 启动开发环境
pnpm tauri dev

# 获取自动化端口（debug 模式下随机）
lsof -nP -iTCP -sTCP:LISTEN | grep my-sekai-

# 在应用内执行 JS
curl -X POST http://127.0.0.1:<PORT>/script/execute \
  -H "Content-Type: application/json" \
  -d '{"script":"return 1+1","args":[]}'

# 其它可用端点：/window/handles /window/set-current /element/find /screenshot
```

## 10. 测量陷阱（避免重复踩坑）

1. **Chromium 与 WKWebView 的读回带宽不同**（1.7 GB/s vs 3.5 GB/s）。用 Chromium 的数据推算应用性能会低估一倍。
2. **`gl.finish()` / `fenceSync` 在 WKWebView 中可能不阻塞**，需用 1×1 `readPixels` 强制同步。
3. **样本量过小会被计时器分辨率吞掉**：200 帧在 4K 轻量着色器下可在 1 ms 内跑完，导致 `dt=0`、fps=Infinity。
4. **`pushVideoBatch` 内部 `toExactUint8Array` 对非整块视图会 `slice()`**，若测试脚本用 `subarray` 提交会引入额外拷贝，严重污染计时。
5. **写盘速度会污染端到端测量**：在空间紧张的卷上，一个 372 MB 文件即可让 I/O 降到 3.4 MB/s，使帧率数据完全失真。

## 11. 已撤回的结论：nv16 吞吐"缺陷"（校验不成立）

曾测得打包吞吐 nv16 = 0.67 GB/s，而 nv12 = 2.20、rgba = 2.39 GB/s，据此判断 nv16 打包路径存在性能缺陷。

**该结论已撤回。** 后续字节级校验显示：在临时脚手架中，**nv12 / nv16 / rgba 三档的输出全部为 0**（即使
加 `gl.finish()`、或改用真实 Pixi RenderTexture + resetExternalState 亦然）。既然已知长期在用的 nv12
在脚手架里同样输出全零，说明**是脚手架不具备保真度，而不是着色器有缺陷**。

同时确认脚手架存在契约错误：`getBatchDestination()` 必须返回按整批（`batchGroupFrames × frameBytes`）
尺寸分配的缓冲区，而脚手架按单帧分配。

**结论**：在拿到可信的内容级基准之前，任何基于该脚手架得出的吞吐差异（含 nv16 慢 2.4 倍）都**不可采信**，
不得据此修改着色器。

### nv16（4:2:2）打包吞吐异常

应用内实测同尺寸 4K 打包器吞吐（不含 IPC 与编码）：

| 格式 | 每帧字节 | 单帧耗时       | fps   | 反推带宽  |
| ---- | -------- | -------------- | ----- | --------- |
| nv12 | 11.87 MB | 6.23 ms        | 160.4 | 2.20 GB/s |
| nv16 | 15.82 MB | 27.87 ms       | 35.9  | 0.67 GB/s |
| rgba | 31.64 MB | 31.64→16.63 ms | 60.1  | 2.39 GB/s |

nv16 每帧字节介于两者之间，带宽却只有其余两档的 1/3，比 rgba（1.9 倍字节）慢 2.4 倍。

**影响**：`balanced` 档的打包上限（35.9 fps）低于 `quality` 档（60.1 fps），而画质又不如 `quality`，形成严格劣势档位。

**怀疑方向**（尚未证实）：

1. nv16 的 UV pass 复用 NV12 的 UV 着色器，视口改为全高后填充行数 1080→2160，纹理访问的垂直局部性变差。
2. 该着色器依赖 GL_LINEAR 中点采样做水平配对，在全高视口下每次采样跨两行，可能导致缓存命中率下降。

**阻碍**：本机 `ffmpeg` 已被移除，无法进行真实导出来做端到端与画质验证；字节级校验（与 `rgbToBt709LimitedY/Uv` 参考实现比对）当前返回全零，说明校验脚手架本身需要修正，尚不能据此判定着色器输出的对错。

**在修正校验方法之前，不应继续堆叠着色器改动。**

## 12. 已实施的优化（本轮）

| 编号 | 内容                                                       | 状态     | 可验证性                                           |
| ---- | ---------------------------------------------------------- | -------- | -------------------------------------------------- |
| O1   | IPC 批次与 PBO 批次解耦（4K RGBA 1→3 帧/批，31.6→94.9 MB） | 已实现   | 调度行为已用 Node 复刻验证（40→14 次调用，无越界） |
| O2   | 允许 2 批在飞（3 缓冲区）                                  | 已实现   | 同上                                               |
| O3   | Rust 侧 `bytes.clone()`                                    | 判定不做 | `request.body()` 仅提供借用，需改 IPC 架构         |

预期收益（基于已实测的 IPC 吞吐曲线 856→1238 MB/s）：

- 4K RGBA：15.5 fps → 约 18~24 fps
- 4K NV12：63.8 fps → 提升有限（原本已是 4 帧/批）

## 13. 重复帧优化（Rust 侧重复写入）

### 动机

剧情类导出中，静止镜头（停顿、长镜头、保持画面）占比常常很高。此类帧的打包结果与上一批**逐字节相同**，
却仍要付出一次完整 IPC 传输（4K RGBA 约 38 ms/批）。既然后端已经持有上一批字节，就没有理由让前端
再传一遍。

### 实现

**后端**（`src-tauri/src/commands/video_export.rs`）

- `FfmpegSession` 新增 `last_batch: Option<Arc<Vec<u8>>>` 与 `last_batch_frames: u64`
- 帧管道通道类型由 `SyncSender<Vec<u8>>` 改为 `SyncSender<Arc<Vec<u8>>>`，保留副本仅需 `Arc::clone`，
  **不额外拷贝整批**（4K RGBA 批次约 95 MB）
- 新增命令 `export_repeat_video_batch(session_id, repeat_count)`：把上一批字节再写 `repeat_count` 遍到
  ffmpeg stdin，并正确累加 `frames_written`；上限 `MAX_REPEAT_BATCH_COUNT = 100_000`

**前端**（`src/export/ffmpegBackend.ts`）

- 维护 `lastDispatchedBufferIndex` / `lastDispatchedFrames`
- 判定采用两级：
  1. **稀疏采样预检**：64 个等距字节 + 首尾中点，任一处不同立即判"不重复"（读取量约 66 字节，≈零成本）
  2. **全量逐字节比对**：仅在预检全等时执行，杜绝误判
- 命中重复时：先 `drainAllInFlight()` 排空在飞批次（保证后端手里的"上一批"与预期一致），再发重复指令
- 因缓冲区在 3 个之间轮转，"上一批"的缓冲在连续两次派发内不会被覆盖，可直接用于比对，无需额外副本

### 已验证

判定逻辑 Node 单测 **6/6 通过**，覆盖易误判场景：

| 场景         | 期望     | 结果 |
| ------------ | -------- | ---- |
| 完全相同     | 判重复   | PASS |
| 非采样点差异 | 判不重复 | PASS |
| 采样点差异   | 判不重复 | PASS |
| 帧数不同     | 判不重复 | PASS |
| 同一缓冲对象 | 不判重复 | PASS |
| 无上一批     | 不判重复 | PASS |

`cargo check` 与 `pnpm typecheck` 均通过。

### 收益模型

重复帧省掉的是整批 IPC（约 38 ms/批），不省 GPU 打包（像素已生成才能比对）。

| 静止批占比 | 4K RGBA 等效帧率（基准 15.5 fps） |
| ---------- | --------------------------------- |
| 0%         | 15.5 fps                          |
| 50%        | ≈ 27 fps                          |
| 70%        | ≈ 43 fps                          |
| 90%        | ≈ 100 fps                         |

### 已知限制

- 批次级判定：仅当**整批**（4K RGBA 为 3 帧）与上一批完全一致时才命中；仅 1~2 帧重复不会命中
- 未做真实导出验证（受 ffmpeg 缺失阻塞），收益数字为模型推算

## 14. 自定义 URI 协议 vs invoke 的二进制上传吞吐对比（否定结论）

### 假设

`invoke` 走 Tauri 的 IPC 序列化管道，而自定义 URI 协议在 macOS 上走 `WKURLSchemeHandler`，
若后者更快，就能绕过约 0.9~1.5 GB/s 的传输瓶颈。

### 实验设置

- 协议端点：`mss://localhost/__bench_upload`（仅 `debug_assertions` 编译），只统计字节数并丢弃
- invoke 端点：`bench_sink_bytes` 命令，同样只统计并丢弃
- 两者用同一份 `Uint8Array` 载荷、同样迭代 6 次、先预热一次
- 端点均为调试期存在，发布构建返回错误或不编译

### 结果

| 载荷  | invoke    | 自定义协议 | 协议相对优势      |
| ----- | --------- | ---------- | ----------------- |
| 8 MB  | 1094 MB/s | 915 MB/s   | **0.84×（更慢）** |
| 32 MB | 1198 MB/s | 1299 MB/s  | 1.08×（快 8%）    |

### 结论

**假设被否证。** 两条通道都落在约 1.1~1.3 GB/s，量级相同：

- 8 MB 时协议反而更慢（每次请求有额外的 URL 解析、CORS、响应构造开销）
- 32 MB 时仅快 8%，不足以支撑切换收益

由此推断，该瓶颈并非 Tauri 的序列化层，而更可能是 WebView 与原生进程之间**无法避免的进程边界拷贝**。
换通道不解决问题。

因此**不切换** `pushVideoBatch`，保留现有 invoke 路径。

顺带得到一个有价值的副产物：纯通道吞吐（32 MB 批）实测 1198 MB/s，明显高于真实导出期间测到的
908 MB/s —— 说明导出时叠加了**编码器回压**。也就是说，真实导出中的"IPC 时间"里有一部分其实是
在等编码器，而非纯传输。

### 下一批候选（按可行性）

1. **重复帧复用**（已实现，见第 13 节）：不传重复批次，是当前唯一被证实有效的减流手段
2. **SharedArrayBuffer 零拷贝**：需要 COOP/COEP 响应头与 webview 配置，WKWebView 支持程度待验证
3. **原生 Metal 渲染**：彻底消除传输，但属于重写渲染层
