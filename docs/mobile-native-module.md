# 移动端原生解码/渲染模块设计（Expo）

移动端不跑 wasm（RN 无 wasm JIT，性能不可控）。解码核心复用同一份 Rust
crate（`packages/core` 的 truehd/eac3/dca 依赖），编为静态库，经 Expo
Modules 暴露给 JS。

## 架构

```
apps/mobile (RN UI, react-three-fiber 3D 视图)
   │ 事件流 (object events, JSON)           ↑ PCM 不出 native 层
   ▼                                        │
modules/sda-core (ExpoModule, Kotlin/Swift)
   │ feed(bytes) / pollEvents()
   ▼
sda-native (Rust staticlib, 新 crate)
   ├─ 解码: truehd / eac3 / dca（与 packages/core 同依赖）
   └─ 渲染: VBAP 增益计算（与 packages/renderer 同算法）
   ▼
音频输出（平台层）
   iOS:     AVAudioEngine + AVAudioEnvironmentNode
            · 每对象一路 mono AVAudioPlayerNode（空间化只作用于 mono 输入）
            · renderingAlgorithm = HRTFHQ
            · isListenerHeadTrackingEnabled = true (iOS 18+, AirPods 头追)
            · distanceAttenuation / reverb → Dolby near/mid/far 近似
   Android: AAudio (低延迟 stream)
            · Rust 内做 VBAP → 虚拟扬声器总线 → 分区卷积(KEMAR HRTF) → 立体声
            · 或设备支持时用 AudioTrack 多声道（USB/HDMI 输出场景）
```

## 为什么 iOS 可以直接用 AVAudioEnvironmentNode

调研结论（docs/binaural-rendering.md §4）：苹果这个 API 就是"对象 PCM +
3D 位置 → 双耳"的现成引擎，HRTFHQ 即双耳渲染，且系统自动应用用户的
个性化空间音频（扫耳建模）——这是自研卷积永远拿不到的。所以 iOS 上
VBAP/HRTF 都不用自己写，native 层只做：解码 → 每对象 mono player node →
按事件流更新 `position`（AudioUnit parameter ramp）。

## Rust ↔ Expo 桥

两种路线：

1. **uniffi**（推荐）：给 `sda-core` 加 `uniffi` feature，导出
   `Decoder { push(bytes), next_frame() }`；uniffi 生成 Swift/Kotlin 绑定，
   Expo Module 持有 Decoder，事件经 `pollEvents(): String`(JSON) 发给 JS
   （`sendEvent("onObjects", ...)`，66ms 节流，与 web 一致）。
2. 手写 C ABI（`#[no_mangle] extern "C"` + 指针），Expo Module 直接调。
   更省依赖，但每加一个 API 都要手写三边。

构建：
- iOS: `cargo build --target aarch64-apple-ios(-sim) --release` →
  `.a` 塞进 Expo Module 的 ios/ podspec（vendored_libraries）
- Android: cargo-ndk → `jniLibs/arm64-v8a, armeabi-v7a, x86_64/libsda.so`

## 里程碑

1. `sda-native` crate：把 `packages/core` 的 pipeline 代码抽成
   `no_std`-friendly 的 lib（去掉 wasm-bindgen 部分按 feature 开关）
2. iOS：Expo Module + AVAudioEnvironmentNode 跑通 .ec3 文件双耳播放
3. iOS 头追 + reverb 距离层
4. Android：AAudio + Rust 自研卷积渲染
5. 3D 视图接 react-three-fiber（支持 RN，同 web 代码思路）
