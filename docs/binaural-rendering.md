# SDA 双耳渲染设计文档

> 基于 Dolby / Apple 官方文档与开源实现（EBU BEAR）调研整理。
> 本文档是 `packages/renderer` 及移动端原生渲染的设计依据。

## 1. 总体架构：虚拟扬声器 + BRIR 卷积

Dolby 渲染器与 EBU/BBC 的 BEAR（Binaural EBU ADM Renderer, Apache-2.0）采用的架构，也是 SDA 采用的架构：

```
对象 PCM + 元数据 (x,y,z,gain,size)
  │
  ├─ (1) Panning: 对象位置 → N 个虚拟扬声器的增益向量
  │      VBAP 3D (Pulkki 1997)；size/spread → 向最近扬声器群扩散
  ├─ (2) 虚拟扬声器总线: 各对象按增益求和到 N 条总线
  │      （复杂度与对象数解耦，卷积次数恒为 N × 2 耳）
  ├─ (3) 双耳化: 每条总线卷积对应位置的 BRIR（左右耳各一条）
  │      → ConvolverNode（FFT 卷积，浏览器原生加速）
  ├─ (4) 距离层: 距离增益(inverse rolloff) + 直达声/混响比 + 频谱
  │      → 逼近 Dolby near/mid/far（见 §3）
  └─ (5) 头追(可选/v2): 旋转世界坐标→头部坐标，重算各扬声器相对方位
```

为什么不是"每对象一个 PannerNode 直接 HRTF"：
- 每个 PannerNode(HRTF) = 2 次卷积，对象数 >~8 时 CPU 失控；
- 无 size/spread 概念；距离只改增益不改音色；
- bed（固定声道布局）与对象无法用同一管线处理。

SDA 里 PannerNode HRTF 仅作为**无 IR 数据时的降级方案**（对 N 条虚拟扬声器总线各用一个 PannerNode，而非每对象一个）。

## 2. 虚拟扬声器布局（7.1.4，ITU-R BS.2051 / Dolby 家庭规范）

| 扬声器 | 方位角 | 仰角 |
|---|---|---|
| L / R | ±30°（+为左） | 0° |
| C | 0° | 0° |
| LFE | +45° | 0°（不参与空间卷积，直通） |
| Ls / Rs | ±100°（90–110°） | 0° |
| Lrs / Rrs（后环绕） | ±140° | 0° |
| Ltf / Rtf（前顶） | ±45° | +45°（规范允许 30–55°） |
| Ltr / Rtr（后顶） | ±135° | +45° |

实现在 `packages/renderer/src/layouts.ts`。

## 3. Dolby 侧：binauralRenderMode 与 near/mid/far

元数据位于 BWF `dbmd` chunk 的 Dolby Atmos Supplemental Metadata segment
（DAMF/ADM profile, EBU Tech 3285 Suppl. 6）。取值（经开源解析器证实，
注意顺序不是按距离递增）：

| 值 | 名称 | 含义 |
|---|---|---|
| 0x00 | BYPASS | 不做双耳处理 |
| 0x01 | NEAR | 近场，声像贴头（~0.5 m 量级）|
| 0x02 | FAR | 远场，房间感/混响最多 |
| 0x03 | MID | 中场（~2 m 量级），默认档 |
| 0x04 | NOT_INDICATED | 未指定，渲染器用默认 |

**语义**：三档对应不同 BRIR 集 —— near 用近头、几乎无房间成分的 HRIR；
mid 用标准听音距离、含少量早期反射的 BRIR；far 用低直达声/混响比的 BRIR。

**SDA 的近似方案**（不必真测三套 BRIR）：同一套位置 BRIR + 三个参数 —
1. 距离增益：near 不衰减；far 按 inverse-square 压 12–20 dB
2. 直达声/混响比：near 全干；far 加房间混响 send
3. 频谱：near 全频；far 加空气吸收式低通

> 注意：harletty 解码出的事件流（OAMD）**不携带** binauralRenderMode —
> 它只存在于 DAMF/dbmd。所以 SDA v1 的距离处理是统一近似；
> 若将来接入 harletty CLI 的 .atmos.metadata 文件，可按对象应用真实模式。

参考：
- Dolby 官方 dbmd 解析器: https://github.com/DolbyLaboratories/dbmd-atmos-parser
- wavinfo 的 dbmd reader（字段表）: https://github.com/iluvcapra/wavinfo
- 《Dolby Atmos Binaural Settings Plug-in Guide》(professional.dolby.com, PDF)

## 4. Apple 侧：移动端原生渲染可用 API（Expo 原生模块设计依据）

### AVAudioEnvironmentNode（iOS，最贴切）
- 隐式听者：`listenerPosition` / `listenerAngularOrientation` / `listenerVectorOrientation`
- **`isListenerHeadTrackingEnabled`（iOS 18+）**：一行接入 AirPods 头追
- 距离衰减：`AVAudioEnvironmentDistanceAttenuationParameters`
  （exponential/inverse/linear + rolloffFactor + referenceDistance + maximumDistance）
- `reverbParameters`（factory presets）→ 模拟 Dolby far 的房间感
- 每输入总线 `renderingAlgorithm`：
  `equalPowerPanning`（最便宜）/ `sphericalHead` / **`HRTF`/`HRTFHQ`（双耳）** / `soundField` / `auto`
- **关键限制：空间化只作用于 mono 输入** → 每个对象挂一路 mono
  AVAudioPlayerNode —— 恰好与"每对象 PCM + 元数据"模型一一对应

### PHASE（iOS 15+，备选/游戏向）
- `PHASESource`(3D 位置 + 体积形状) / `PHASEListener` / `PHASESoundEvent`
- `PHASESpatialPipeline` flags: directPathTransmission / earlyReflections /
  lateReverb —— 直达声/早期反射/晚期混响分层
- 距离模型 `PHASEGeometricSpreadingDistanceModelParameters`:
  **rolloffFactor 1.0 = 距离每加倍衰减 6 dB**（物理正确值，TS 实现同款默认）
- `PHASEEngine.outputSpatializationMode = alwaysUseBinaural`
- 个性化空间音频（扫耳建模）：系统自动应用，需 entitlement
  `com.apple.developer.spatial-audio.profile-access`；
  头追 entitlement `com.apple.developer.coremotion.head-pose`
- 自研渲染的游戏需 Info.plist `AVGameBypassSystemSpatialAudio = true` 防双重空间化

### 系统级（AVPlayer）
iOS 15+ 系统对 Atmos 内容自动做头追双耳；`AVAudioSession.SpatialExperience`
（iOS 18.1+）声明 bypassed/fixed/headTracked。SDA 自研渲染时设为 bypassed。

### Android
无系统级对象渲染 API → 走自研管线：Rust 侧实现 VBAP + 分区卷积
（与 TS 渲染器同算法，可共享 HRTF 数据），经 AAudio 低延迟输出。
可选头追：Android HeadTracker API（`android.hardware.SensorManager` 头追或
`android.media.audiofx`？v2 再定）。

## 5. 可合法打包的 HRTF 数据集

**格式标准：SOFA（AES69）**，netCDF-4 容器；离线预转为 SDA 自定义
f32le 格式（见 `packages/renderer/src/hrtf.ts`），运行时零解析成本。

| 数据集 | 内容 | 许可 |
|---|---|---|
| **MIT KEMAR** | 710 位置，44.1kHz，含 diffuse-field EQ 版 | **"free with no restrictions on use"**（要求引用）→ **首选** |
| CIPIC | 45 真人，1.27 m | 免费 license agreement，条款需核实 |
| LISTEN (IRCAM) | ~50 被试 | Chromium HRTF 的源头；许可需核实 |
| SADIE II (York) | 20 被试 HRTF + BRIR + 耳机 EQ | 免费协议，学术友好；BEAR 备选 |
| TH Köln / HUTUBS | 96 头高分辨率 | CC 系；BEAR 的 HRIR_FULL2DEG 即此 |
| BBC R&D (BEAR 默认) | 录音室 KU100 BRIR | 见 ebu/bear 仓库 |

**打包建议**：MIT KEMAR（无限制）做主 HRTF。它是自由场 HRIR（无房间成分），
正好配合 §3 的参数化 near/mid/far。转换管线（SOFA → f32le manifest）：
用 Python `pysofaconventions` 或 netCDF4 读取 → 按 SDA 扬声器方位角
就近取测量点 → 重采样到 48k → 裁剪到 128–256 taps → 写 `hrtf-set.json` + `*.f32`。

- SOFA 规范: https://www.sofaconventions.org/
- 数据集索引: https://www.sofacoustics.org/data/database/
- MIT KEMAR: https://sound.media.mit.edu/resources/KEMAR.html
- BEAR: https://github.com/ebu/bear （IR 处理: doc/ir_processing.md）

## 6. Web Audio PannerNode HRTF 能力与局限（降级方案依据）

- `panningModel: "HRTF"` 输出恒为立体声，内置通用 KEMAR 类 HRTF
- 距离仅改增益（`distanceModel` + rolloffFactor），**不改 HRTF 本身**
  （无近/远场音色、无混响）→ 需要自有距离层（§3）补偿
- 位置是 AudioParam 可平滑 —— 对元数据流友好
- 无个性化 HRTF、无内建头追（需自更新 `AudioListener` 朝向）
- 规范: https://webaudio.github.io/web-audio-api/#dom-pannernode-panningmodel

## 7. 坐标系约定（实现期最大的坑）

| 系统 | 约定 |
|---|---|
| ADM / OAMD 事件流 | 笛卡尔 [x,y,z]：x+ = 左，y+ = 前，z+ = 上（单位立方体） |
| ADM 极坐标（VBAP 内部） | 方位角 0°=前，+ = 左；仰角 + = 上 |
| Web Audio / three.js | 右手系：x+ = 右，y+ = 上，z+ = 朝听者（听者面朝 -z） |

转换（`packages/renderer/src/coords.ts`）：
- ADM → WebAudio: `(x, y, z) → (-x, z, -y)`
- 事件流里的距离 = √(x²+y²+z²)，1 = 扬声器环半径

> ⚠️ 待验证：ADM 笛卡尔 X 轴方向（+X = 左还是右）在不同资料中表述不一，
> 以上取 harletty-bridge 注释与 ITU-R BS.2076 通行解释（+X = 左）。
> 用已知内容（如 Atmos 演示片"从左到右飞的直升机"）做视觉校验，
> 若反了只需翻转 `coords.ts` 一处。

## 8. 待核实清单（调研遗留）

1. Dolby near/mid/far 精确距离数值 —— 对照《Dolby Atmos Binaural Settings
   Plug-in Guide》PDF 原文
2. CIPIC / SADIE II / TH Köln 许可条文细节
3. `AVAudioSession.SpatialExperience` 枚举确切 case 名
4. ITU-R BS.2051 扬声器角度表原文（付费标准，本文用行业通行值）
