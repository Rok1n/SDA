# 卡顿问题交接（另一台机继续修）

## 现象（用户机器上，稳定）

- 播放中做任何非本应用操作都卡：切窗口、alt+tab、双击桌面图标、最小化其他窗口。
- **最稳定复现：播放时打开任务管理器**。
- 用户最新观察："貌似在 obj 移动的时候会卡"。
- 测试内容：`C:\Users\legendshop\Downloads\01. KiLLKiSS.m4a`（ec-3 JOC，LFE + 15 动态对象，209.7s，dialnorm=-18）。
- 本机（开发机，较快）**无法复现**输出侧间隙；症状只在用户机器出现 → 大概率是"余量不足"型问题，用户机器 CPU/调度余量更小。

## 音频管线现状（v0.1.3，已发布）

```
decoder worker (WASM sda_core) → 主线程 player 泵帧 → AudioWorklet 环形缓冲
(262144 samples ≈ 5.3s @48k，前瞻 TARGET_AHEAD 4s) → 18 总线混音 → 每总线
ConvolverNode (KU100 BRIR 8192 taps 双耳) → EQ → +6dB makeup → 联动 limiter
(peak guard worklet，5ms lookahead) → AudioContext 输出（latencyHint 0.1s →
baseLatency 100ms）→ WASAPI
```

已做过的修复（都不能再重复指望）：Chromium 防节流开关 ×3、文件弹窗挂父窗口、硬件 GPU 渲染 3D 视图、进程树 High 优先级（30s 兜底）、输出 FIFO 20ms→100ms、播放头按 baseLatency 回拨补偿。

## 已用测量排除的假设（不要回头再猜）

1. **+6dB `BINAURAL_MAKEUP_GAIN` 导致 limiter 泵音**：已证伪。离线逐样本复刻 limiter 跑真实歌曲（`tmp/object-motion-limiter-test.mjs`）：GR 仅 4% 时间、最深 -1.5dB、与对象运动相关性 0.012。
2. **输出侧回调间隙（本机）**：worklet 埋点 `callbackGaps`（process() 相邻调用 >12ms 计数）+ 供给不足计数，taskmgr 压测期间全零（`tmp/taskmgr-repro-test.mjs`、`tmp/latency-fix-verify.mjs`）。**但这是在开发机上**——用户机器上没有数据，这是最大的信息缺口。
3. **输入侧缓冲不足**：环形缓冲 4s 前瞻，不可能因为主线程偶发繁忙见底。

## 关键新线索（本轮最后测出）

**软解吞吐量只有 4.2x 实时**（Node 24 离线测全文件：209.7s 音频解码 50.2s，占单核 ~24%）。构建已是 release（opt-level 3 / thin LTO / codegen-units 1），没有 debug 白捡的空间。含义：

- 机器空闲时 24% 单核没问题；但用户机器若更慢/有持续负载，解码 worker 余量很薄。环形缓冲 4s 能吸抖动，吸不了"解码长期低于 1x 实时"。
- WASM 没开 SIMD128（没试过；`RUSTFLAGS="-C target-feature=+simd128"` 重新 `pnpm core:build` 后重测吞吐，Chrome/Electron/Node24 都支持 wasm SIMD）。

## 第一优先级：让用户机器自己报告（把遥测摆到台面上）

现在健康数据只进 console（release 里用户看不到；日志面板已被用户要求隐藏）。把以下字段加进"码流"面板的"诊断"行，用户复现卡顿时直接读数：

- `callbackGaps` / `callbackGapMaxMs`（输出侧调度间隙）→ 判别"输出级 stall"
- `underrunSamples` / 供给不足（环形缓冲见底）→ 判别"解码/泵帧跟不上"
- 解码实时倍率：player 里记 `decodedSeconds / wallSeconds`（播放中滑动窗口）
- worklet `process()` 自身执行耗时均值/峰值（判别 audio 线程算力超限：18 总线 × 17 方向卷积器 + 混音都在这条线程上，quantum 预算 2.67ms）

落点：`packages/player/src/player.ts` `reportRendererHealth`（已有雏形），`apps/web/src/App.tsx` 码流面板 `诊断` 行（`setDebug` 链路）。

判读规则：
- 卡顿时 `callbackGaps` 涨 → 输出级/audio 线程问题 → 走"减 audio 线程负载"和"加大输出缓冲"路线
- 卡顿时 underrun 涨、callbackGaps 不涨 → 解码/供给问题 → 走"解码提速"路线
- 都不涨但用户仍听到卡 → 缺口在 app 之外（蓝牙链路/驱动/DPC），换耳机线/独占模式对比测

## 候选修复路线（按优先级）

### A. 解码提速（如果遥测指向供给不足）
1. SIMD128 重编 WASM，重测离线吞吐（基线 4.2x）：
   `RUSTFLAGS="-C target-feature=+simd128" pnpm core:build`，然后用本文末尾的离线计时法重测。
2. profile JOC 重建热点（harletty-bridge/eac3，15 对象的矩阵运算是大头；`packages/core/src/eac3_pipeline.rs`）。可写原生 bench（crate 是 rlib）用 VS/perf 采样。
3. 每帧 serde_json 序列化（eventsJson/objectChannelsJson）有小额开销，可改二进制布局，但别先做。

### B. 减 audio 线程负载（如果遥测指向回调间隙）
1. **卷积器按逻辑布局裁剪**：现在 `buildBinauralBank` 给 18 总线拓扑全集每总线都建 ConvolverNode，当前布局用不到的总线（增益恒 0）也在白烧 CPU。布局切换时按逻辑布局重建卷积图：5.1.4→9 个、7.1.4→11、9.1.4→13（现在恒 17+）。落点：`packages/renderer/src/renderer.ts` `buildBinauralBank` / `setLayout`。
2. 输出缓冲自适应升级：检测到 callbackGaps 持续非零时，重建 AudioContext 把 latencyHint 从 0.1 升到 0.2/0.3（`packages/player/src/player.ts` `OUTPUT_LATENCY_SECONDS`，重建链路 `recreateRenderer` 已有）。
3. IR 长度 8192→更短的方案**不建议**（动音色，违反校准语义）。

### C. 用户环境侧排查（遥测都不涨时做）
- 用户若用蓝牙耳机（仓库里有 airpods-pro-2 文档）：A2DP 链路本身会卡，换有线耳机对比。
- DPC 延迟（网卡/显卡驱动）：让用户跑 LatencyMon 看有没有红条。
- 设备默认 44.1kHz，码流 48kHz，Chromium 重采样有少量常驻 CPU；可在支持的设备上把系统默认格式改 48kHz 对比。

## 为什么不上"硬件解码"（用户提过，要有理有据地回答）

- Windows 没有对外暴露保留 JOC 对象元数据的 EC-3 解码器：Media Foundation 的 EC-3 MFT 只输出声道 PCM（对象被渲染/丢弃），TrueHD/DTS 同理。**硬解 = 丢掉 15 路动态对象 = 这个 app 的核心架构（对象→VBAP→KU100 双耳）整个不存在了**，3D 视图、solo/mute、布局差异全灭。
- 解码也不是当前证据指向的瓶颈：4.2x 实时 + 4s 环形缓冲，只有在用户机器长期把 worker 压到 1x 以下才会卡——这要先用遥测证实（供给不足计数），而不是直接换解码器。
- 如果用户机器上"供给不足"持续涨且 SIMD 后仍不够，再讨论：ec-3 也有官方/FFmpeg 的优化解码路径可借鉴（仍软件、仍保对象）。

## 复现与测试基建

- dev 环境：
  ```bash
  pnpm --filter @sda/web preview --host 127.0.0.1 --port 4173   # 先 build
  SDA_DEV_URL=http://127.0.0.1:4173 pnpm --filter @sda/desktop exec electron . --dev \
    --remote-debugging-port=9222 -- "C:\Users\legendshop\Downloads\01. KiLLKiSS.m4a"
  ```
- CDP 测试：`tmp/taskmgr-repro-test.mjs`（播放中开 taskmgr 收集 console）、`tmp/probe-latency-hints.mjs`（实测 latencyHint→baseLatency）、`tmp/v3-runtime-smoke.mjs`。
- 离线吞吐计时：见本文"关键新线索"一节方法（`tmp/killkiss-layout-lr.mjs` 头部的 decode 段可直接复用）。
- GitHub 推送代理常失效：`git -c http.proxy= -c https.proxy= push origin master`。
- 发版教训：tag 前先 bump `apps/desktop/package.json` version（安装包文件名取自它）。本轮不需要发版。

## 当前仓库状态

- master 已推送至 v0.1.3（commit 94c70be）：100ms 输出缓冲 + 遥测埋点 + calibration v3 镜像对称化（7.1/9.1 左右平衡已修，与本卡顿无关）+ 码流面板响度行。
- 工作区干净；`tmp/` 下诊断脚本均已提交。
