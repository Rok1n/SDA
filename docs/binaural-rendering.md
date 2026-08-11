# SDA 双耳渲染设计文档

> 基于 Dolby / Apple 官方文档与开源实现（EBU BEAR）调研整理。
> 本文档是 `packages/renderer` 及移动端原生渲染的设计依据。
> **2026-08 更新：§1–§5 描述的管线已全部落地实现**（见各节「实现」注记）。

## 1. 总体架构：虚拟扬声器 + BRIR 卷积

Dolby 渲染器与 EBU/BBC 的 BEAR（Binaural EBU ADM Renderer, Apache-2.0）采用的架构，也是 SDA 采用的架构：

```
对象 PCM + 元数据 (x,y,z,gain,size)
  │
  ├─ (1) Panning: 对象位置 → N 个虚拟扬声器的增益向量
  │      VBAP 3D (Pulkki 1997)；size/spread → 向最近扬声器群扩散
  ├─ (2) 虚拟扬声器总线: 各对象按增益求和到 N 条总线（AudioWorklet）
  │      （复杂度与对象数解耦，卷积次数恒为 N × 2 耳）
  │      + 每源一阶低通（空气吸收，苹果/杜比远场 cue）
  ├─ (3) 双耳化: 每条总线卷积对应位置的「干 HRIR ↔ 湿 BRIR 混合」IR
  │      → ConvolverNode（FFT 卷积，浏览器原生加速）
  ├─ (4) 距离层: 苹果 inverse 距离定律（参考距离内不衰减）+ 空气吸收低通
  │      → Dolby near/mid/far = 干/湿混合比 + 参考距离 0.7/1.2/2.5m（见 §3）
  └─ (5) 头追(可选/v2): 旋转世界坐标→头部坐标，重算各扬声器相对方位
```

为什么不是"每对象一个 PannerNode 直接 HRTF"：
- 每个 PannerNode(HRTF) = 2 次卷积，对象数 >~8 时 CPU 失控；
- 无 size/spread 概念；距离只改增益不改音色；
- bed（固定声道布局）与对象无法用同一管线处理。

SDA 里 PannerNode HRTF 仅作为**无 IR 数据时的降级方案**（对 N 条虚拟扬声器总线各用一个 PannerNode，而非每对象一个）。

> **实现**：worklet 总线混合 + 每源低通在
> `packages/renderer/worklet/sda-renderer.worklet.js`；双耳图（splitter →
> 每总线 ConvolverNode → merger）在 `packages/renderer/src/renderer.ts`；
> LFE 无方向性，等量直送双耳不卷积（杜比双耳渲染惯例）。

### 1.1 床声道：音箱吸附 + 上混扩展（AVR 语义）

床声道（5.1/7.1 等固定声道）与对象走不同平移路径，对齐真实 AVR/物理系统：

- **吸附（direct）**：床标签命中布局音箱 → 直送该音箱总线（增益 1.0），不用
  VBAP 摊到相邻音箱 —— 真实 7.1 系统放 5.1 内容，Ls 就是从侧环绕一只箱子出声。
  布局里没有该音箱（如 7.1 内容选 5.1 布局）才回退 VBAP 平移。
- **上混扩展（DSU 静态近似）**：所选布局大于内容床时把床填满布局——
  侧环绕馈后环 0.5（5.1 → 7.1.x 后环不再沉默，合成声像略后移，恰好贴近 5.1
  环绕 ±110° 的制作位）、前左/右馈前宽 0.35（9.1 布局拉开前声场）。
  目标总线被真实床声道占用时馈送撤回（7.1 内容的后环不吃 5.1 式馈送）。
  顶层不做静态派生（环境声提取超出渲染器职责）。
- 三种输出模式共用同一机制（增益向量层）：双耳 = 扩展后的总线各自卷积；
  多声道 = 扩展后的总线直出物理声道。

多声道直出额外做两件物理对齐：`destination.channelCount` 显式设为布局
音箱数（否则浏览器默认 2 声道降混），总线按 WASAPI/HDMI 通道掩码顺序重排
（7.1：FL FR C LFE **BL BR SL SR**，后环在侧环前；不重排则 Windows 多声道
设备上侧环/后环互换）。

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

**SDA 的实现**（`packages/renderer/src/hrtf.ts`）：同一测量方向的
**干 HRIR（消声室直达）与湿 BRIR（含房间早期反射 + ~170ms 尾音）按时域对齐混合**：
`IR = (1-w)·HRIR + w·BRIR`，混合后能量归一化（近/中/远切换响度一致）。
BRIR 自带房间响应，正是杜比房间 cue 的来源，无需独立混响总线。

| 档位 | 湿声权重 w | 参考距离 | 听感 |
|---|---|---|---|
| near 近 | 0.1 | 0.7 m | 贴头、干、直接 |
| mid 中（默认） | 0.3 | 1.2 m | 标准听音位、少量房间 |
| far 远 | 0.6 | 2.5 m | 房间感强、直达声占比低 |

配合每源距离处理（`renderer.ts applyGains`）：
1. **苹果 inverse 距离定律**：`gain = ref/d`，参考距离内不衰减
   （ADM 距离 1 = 音箱环 = 当前档位参考距离；房间角落 √3 处才触发衰减）
2. **空气吸收低通**：越远截止频率越低（∝(ref/d)²，上限 19kHz），
   worklet 内每源一阶低通实现

> 注意：harletty 解码出的事件流（OAMD）**不携带** binauralRenderMode —
> 它只存在于 DAMF/dbmd。所以 SDA 的距离档位是全局固定值（UI 曾暴露近/中/远，
> 现固定"近"；引擎保留三档机制，IR 重混 + 增益平滑重推不中断音频）；
> 若将来接入 harletty CLI 的 .atmos.metadata 文件，可按对象应用真实模式。

参考：
- Dolby 官方 dbmd 解析器: https://github.com/DolbyLaboratories/dbmd-atmos-parser
- wavinfo 的 dbmd reader（字段表）: https://github.com/iluvcapra/wavinfo
- 《Dolby Atmos Binaural Settings Plug-in Guide》(professional.dolby.com, PDF)

## 3.5 监听系统仿真：真力 The Ones + 7370A（EQ / 低频管理补偿）

3D 视图里的虚拟音箱是真力 The Ones 同轴系列 + 73 系列低音炮，双耳渲染
模拟的就是这套监听系统在房间里的声音。官网实测指标：

| 型号 | 自由场频响 | -6dB 下限 | 说明 |
|---|---|---|---|
| 8331A | 58 Hz – 20 kHz (±1.5 dB) | 45 Hz | The Ones 最小 |
| 8341A | 45 Hz – 20 kHz (±1.5 dB) | 38 Hz | The Ones 中号 |
| 8351B | 38 Hz – 20 kHz (±1.5 dB) | 32 Hz | The Ones 最大 |
| 7370A | 19 – 100 Hz (±3 dB) | 19 Hz / 150 Hz | 12" 低音炮 |

关键结论：**The Ones 轴上响应在通带内 ±1.5 dB，本质是平的，没有可补偿的
"每音箱 EQ"**。杜比对 5.1 / 5.1.2 / 5.1.4 / 7.1.2 / 7.1.4 / 9.1.2 / 9.1.4 /
9.1.6 各布局也只公布**摆位角度**（ITU-R BS.775 / BS.2051，见 §2），从未公布
逐音箱 EQ 曲线 —— 唯一成文的音箱相关 EQ 是 Dolby Atmos Enabled（向上反射）
音箱的目标曲线，而我们的布局全部是入顶箱，不适用。

杜比 / ITU 真正成文、且可听的两条低频规范（已实现）：

1. **低频管理（bass management）**：主音箱设为 "small" 时，分频点以下的
   低频从各主音箱剥离、重定向到低音炮重放。分频点取真力多声道监听的
   常用值 **85 Hz**（SAM 系列炮的分频由 GLM 软件配置，并非硬件固定值）。
   低频不可定位，低音炮信号不卷积、直送双耳。
2. **LFE 通道规范（ITU-R BS.775 / 杜比）**：LFE 带宽限制 **120 Hz**（编码侧
   低通），重放时施加 **带内 +10 dB** 增益（录制侧 -10 dB，换取 10 dB 余量）。
   真力 7360A/7370A 官网的「LFE 输入电平 0 / +10 dB re. main channels」
   开关直接印证了该约定。

`renderer.ts` 双耳路径的实现（全部用 Web Audio BiquadFilter 级联成 LR4
—— 两个 Q=1/√2 的二阶级联，分频点 -6dB、高低通同相叠加平坦）：

```
主音箱总线 → LR4 高通 @85Hz → 方向 IR 卷积 → 双耳
           → LR4 低通 @85Hz ─┐
LFE 总线   → LR4 低通 @120Hz → +10dB ─┤→ 低音炮总线 → LR4 高通 @19Hz
                                      │   (7370A 次声滚降，上限 150Hz
                                      └→  由 85/120Hz 低通保证) → 直送双耳
```

效果：每个主音箱听起来像接了炮的 The Ones（85Hz 以下交给炮），低频下潜到
19Hz，LFE 有正确的带内响度 —— 正是真力官方推荐的多声道监听接法。

参考：
- Genelec 8331A / 8341A / 8351B / 7370A 官网规格页（genelec.com）
- Genelec GLM 校准默认分频 85 Hz（Genelec 多声道监听设置指南）
- ITU-R BS.775-3（LFE 20–120 Hz，+10 dB 带内增益）
- Dolby Atmos Home Theater Studio Guidelines（摆位 + 低频管理概念，无逐音箱 EQ）

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

## 5. HRTF 数据集：SADIE II KU100（已落地）

**格式标准：SOFA（AES69）**，netCDF-4 容器；但 SADIE II 同时发布 **WAV 版本**，
SDA 直接用 WAV（Node 脚本零依赖解析，不需要 Python/netCDF）。

| 数据集 | 内容 | 许可 |
|---|---|---|
| **SADIE II D1 (York)** | **Neumann KU100 假头**：HRIR（消声室）+ BRIR（房间）+ 耳机 EQ | **Apache-2.0** → **首选，干湿两全** |
| MIT KEMAR | 710 位置，44.1kHz，仅 HRIR | "free with no restrictions on use"（要求引用）→ 备选（只有干声） |
| CIPIC | 45 真人，1.27 m | 免费 license agreement，条款需核实 |
| LISTEN (IRCAM) | ~50 被试 | Chromium HRTF 的源头；许可需核实 |
| TH Köln / HUTUBS | 96 头高分辨率 | CC 系；BEAR 的 HRIR_FULL2DEG 即此 |
| BBC R&D (BEAR 默认) | 录音室 KU100 BRIR | 见 ebu/bear 仓库 |

**选 SADIE II KU100 的理由**：① Apache-2.0 可随应用自由再发布；② 同一假头
同时有 HRIR 和 BRIR —— 杜比 near/mid/far 的「干/湿混合」方案（§3）正好需要
成对的干湿数据；③ KU100 与 SDA 3D 视图里的假头模型一致。

**转换管线**（`scripts/build-hrtf.mjs`，Node 零依赖）：
下载/读取 WAV zip → 从文件名解析方位角/仰角 → 为全部布局的 17 个音箱方向
就近取测量点 → 截断（HRIR 512 taps / BRIR 8192 taps）→ 双耳峰值归一化
（保 ILD）→ 写 `apps/web/public/hrtf/hrtf-set.json` + `*.f32`（f32le，
`[leftIR][rightIR]` 拼接）。运行时加载/混合/重采样见
`packages/renderer/src/hrtf.ts`。

> ⚠️ 方位角约定：SDA 为 + = 左（ADM/ITU），多数数据集为 + = 右，
> 脚本默认 `--flip-az` 取反匹配（选对称侧的测量点，声道不互换）。

- SOFA 规范: https://www.sofaconventions.org/
- 数据集索引: https://www.sofacoustics.org/data/database/
- SADIE II: https://doi.org/10.5281/zenodo.12092466 （D1.zip = KU100 全部 WAV，
  `azi_<方位角,小数>_ele_<仰角,小数>.wav` 逗号小数命名，方位角 + = 左与 ADM 一致；
  引用：DOI 10.3390/app8112029）
- MIT KEMAR: https://sound.media.mit.edu/resources/KEMAR.html （备选，仅干声 HRIR）
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
