/**
 * Main-thread spatial renderer.
 *
 * Graph:
 *   AudioWorkletNode(sda-renderer, N-bus output)
 *     ├── "multichannel": → ctx.destination (N discrete channels)
 *     ├── "binaural":     → ChannelSplitter(N)
 *     │                     → 低频管理（LR4 分频 @85Hz）→ 主总线 / 低音炮总线
 *     │                     → per 主总线: ConvolverNode(stereo BRIR/HRIR mix)
 *     │                     → 低音炮总线: LFE(120Hz LP +10dB) + 各主总线低频
 *     │                       → 真力 7370A 响应（19Hz 次声滚降）→ 直送双耳
 *     │                     → ChannelMerger(2) → ctx.destination
 *     └── "stereo":       → downmix gain matrix → merger(2) → destination
 *
 * 双耳路径遵循业界标准虚拟音箱方案（杜比 BS.2127 / Apple 虚拟化 5.1）：
 * 对象先 VBAP 到固定虚拟音箱环，每个虚拟音箱与该方向的
 * 「干 HRIR + 湿 BRIR 按模式混合」的 IR 卷积求和。卷积数固定（总线数 × 2 耳），
 * 与对象数量解耦。近/中/远（杜比 Binaural Settings）= 干/湿混合比 +
 * 参考距离；苹果式 inverse 距离定律 + 空气吸收低通在源侧（worklet）施加。
 *
 * 监听系统仿真（真力 The Ones + 7370A）：杜比未公布各布局逐音箱 EQ（只有
 * 摆位角度、低频管理概念和 LFE 规范），可听的声音塑造来自监听音箱本身。
 * 按官网指标建模：The Ones 轴上 ±1.5dB 平直（无需补偿），GLM 默认低频管理
 * 分频 85Hz（LR4 = 两个 Q=1/√2 的二阶级联）；LFE 按 ITU-R BS.775 / 杜比规范
 * 120Hz LR4 低通 + 带内 +10dB；7370A：-6dB @19Hz 次声滚降、上限 150Hz。
 */

import { admToSpherical, sphericalToWebAudio, type Spherical } from "./coords.js";
import {
  LAYOUT_7_1_4,
  positionForLabel,
  isLfeLabel,
  aliasLabel,
  physicalChannelOrder,
  type VirtualSpeaker,
} from "./layouts.js";
import { VbapSolver } from "./vbap.js";
import { buildBusIrs, type BinauralIrSet, type BinauralMode } from "./hrtf.js";
import type { ObjectEvent } from "@sda/core";

export type OutputMode = "multichannel" | "binaural" | "stereo";

/** 低频管理分频点：真力多声道监听常用值 85Hz（SAM 炮由 GLM 软件配置）。 */
const BM_CROSSOVER_HZ = 85;
/** LFE 低通：ITU-R BS.775 / 杜比规范 120Hz。 */
const LFE_LOWPASS_HZ = 120;
/** LFE 带内增益：杜比监听规范 +10dB（编码侧 -10dB 录制，重放逐带补偿）。 */
const LFE_INBAND_GAIN = Math.pow(10, 10 / 20);
/** 真力 7370A 低频截止：-6dB @19Hz。 */
const SUB_CUTOFF_HZ = 19;

export interface RendererOptions {
  mode?: OutputMode;
  layout?: readonly VirtualSpeaker[];
  /** 预加载的双耳 IR 集（SADIE II KU100 派生）；也可 init 后 setBinauralData。
   *  缺省时双耳模式回退到浏览器内置 PannerNode HRTF。 */
  binauralIrSet?: BinauralIrSet;
  /** worklet 每消耗约 1/8 秒回调一次 —— 播放器用它泵入更多 PCM（背压）。 */
  onConsumedTick?: () => void;
}

/** Scalar spread derived from ADM object size (w, d, h in [0,1]). */
function sizeToSpread(size: [number, number, number]): number {
  return Math.min(1, (size[0] + size[1] + size[2]) / 3);
}

interface SourceState {
  id: string;
  spread: number;
  position: Spherical;
  gainDb: number;
  isLfe: boolean;
  /** 对象静音（mute/solo）：静音时标量增益乘 0，走平滑斜坡无爆音。 */
  muted: boolean;
  /** 床声道吸附的布局音箱总线索引（-1 = 布局中无此音箱，回退 VBAP）。 */
  snapBus: number;
  lfeBus?: number;
}

export class SpatialRenderer {
  readonly ctx: AudioContext;
  readonly layout: readonly VirtualSpeaker[];
  readonly mode: OutputMode;
  private vbap: VbapSolver;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private postNodes: AudioNode[] = [];
  /** 双耳路径每总线的卷积器（LFE/兜底位置为 null），切模式时只换 buffer。 */
  private convs: (ConvolverNode | null)[] = [];
  private sources = new Map<string, SourceState>();
  private irSet: BinauralIrSet | null = null;
  /** 床扩展表（AVR 上混器语义）：床音箱总线 → 派生馈送。内容床小于所选布局时
   *  把床填满布局 —— 侧环绕馈后环、前馈前宽；目标总线已被真实床声道占用则跳过。 */
  private expansion = new Map<number, { bus: number; gain: number }[]>();
  /** 杜比 Binaural Settings 语义：虚拟音箱参考距离。UI 固定"近"（0.7m）；
   *  mid/far 机制保留在引擎内，暂不从界面暴露。 */
  private binauralMode: BinauralMode = "near";
  private onConsumedTick?: () => void;
  /** Frames actually rendered by the worklet (authoritative playhead). */
  consumedSamples = 0;

  constructor(ctx: AudioContext, options: RendererOptions = {}) {
    this.ctx = ctx;
    this.mode = options.mode ?? "binaural";
    this.layout = options.layout ?? LAYOUT_7_1_4;
    this.vbap = new VbapSolver(this.layout);
    if (options.binauralIrSet) this.irSet = options.binauralIrSet;
    this.onConsumedTick = options.onConsumedTick;
    this.buildExpansion();
  }

  /** 上混扩展规则（杜比 DSU / AVR 上混器的静态近似）：
   *  - 侧环绕 → 后环 0.5（5.1 内容在 7.1+ 布局：后环不再沉默，声像略后移
   *    恰好贴近 5.1 环绕的 ±110° 制作位）
   *  - 前左/右 → 前宽 0.35（9.1 布局：拉开前声场宽度，中置对白不动）
   *  顶层不做静态派生（环境声提取超出本渲染器职责）。 */
  private buildExpansion(): void {
    const idx = (name: string) => this.layout.findIndex((s) => s.name === name);
    const feed = (from: string, to: string, gain: number) => {
      const a = idx(from);
      const b = idx(to);
      if (a < 0 || b < 0) return;
      const list = this.expansion.get(a) ?? [];
      list.push({ bus: b, gain });
      this.expansion.set(a, list);
    };
    feed("SurroundLeft", "RearLeft", 0.5);
    feed("SurroundRight", "RearRight", 0.5);
    feed("FrontLeft", "WideLeft", 0.35);
    feed("FrontRight", "WideRight", 0.35);
  }

  /** Load the worklet module and build the downstream graph. */
  async init(workletModuleUrl: string | URL): Promise<void> {
    await this.ctx.audioWorklet.addModule(workletModuleUrl);
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.node = new AudioWorkletNode(this.ctx, "sda-renderer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.layout.length],
      processorOptions: { busCount: this.layout.length },
    });
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "tick") {
        this.consumedSamples = e.data.consumed;
        this.onConsumedTick?.();
      }
    };
    this.buildOutputGraph();
  }

  /** 注入双耳 IR 集（可在 init 后、播放前随时调用），重建双耳输出图。 */
  setBinauralData(set: BinauralIrSet): void {
    this.irSet = set;
    if (this.mode === "binaural" && this.node) this.buildOutputGraph();
  }

  /** 切换杜比近/中/远：重混每总线 IR（干 HRIR ↔ 湿 BRIR）并换卷积 buffer，
   *  同时按新参考距离重算所有源的距离增益 —— 播放中实时切换，不中断音频。 */
  setBinauralMode(mode: BinauralMode): void {
    if (mode === this.binauralMode) return;
    this.binauralMode = mode;
    if (this.mode !== "binaural") return;
    if (this.irSet) {
      const irs = buildBusIrs(this.ctx, this.irSet, this.layout, mode);
      this.convs.forEach((conv, bus) => {
        const ir = irs.get(bus);
        if (conv && ir) conv.buffer = ir;
      });
    }
    // 距离定律随模式改变（参考距离不同），平滑重推全部源的增益。
    for (const state of this.sources.values()) this.applyGains(state, 4096);
  }

  get binauralModeName(): BinauralMode {
    return this.binauralMode;
  }

  private teardownPostNodes(): void {
    for (const n of this.postNodes) n.disconnect();
    this.postNodes = [];
    this.convs = [];
  }

  /** LR4（Linkwitz-Riley 四阶）滤波对：两个 Q=1/√2 的二阶 biquad 级联，
   *  级联后分频点处 -6dB，高低通同相叠加平坦。返回 [入口, 出口]。 */
  private lr4(type: BiquadFilterType, freq: number): [BiquadFilterNode, BiquadFilterNode] {
    const a = this.ctx.createBiquadFilter();
    const b = this.ctx.createBiquadFilter();
    for (const f of [a, b]) {
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = Math.SQRT1_2;
    }
    a.connect(b);
    return [a, b];
  }

  private buildOutputGraph(): void {
    if (!this.node || !this.master) return;
    this.teardownPostNodes();
    const n = this.layout.length;

    if (this.mode === "multichannel") {
      // 物理声道直出：目标声道数 = 布局音箱数（受设备上限钳制），并按
      // WASAPI/HDMI 通道掩码顺序重排总线（7.1：后环在侧环前），否则 Windows
      // 多声道设备上侧环/后环会互换。设备能力不足时保持默认降混。
      const dest = this.ctx.destination;
      try {
        dest.channelCountMode = "explicit";
        dest.channelCount = Math.max(2, Math.min(n, dest.maxChannelCount || n));
      } catch {
        /* 设备不允许显式声道数：交由浏览器降混 */
      }
      const order = physicalChannelOrder(this.layout);
      const splitter = this.ctx.createChannelSplitter(n);
      const merger = this.ctx.createChannelMerger(n);
      this.node.connect(splitter);
      order.forEach((bus, i) => splitter.connect(merger, bus, i));
      merger.connect(this.master);
      this.postNodes.push(splitter, merger);
      return;
    }

    const splitter = this.ctx.createChannelSplitter(n);
    this.node.connect(splitter);
    const merger = this.ctx.createChannelMerger(2);
    merger.connect(this.master);

    const busIrs = this.mode === "binaural" && this.irSet
      ? buildBusIrs(this.ctx, this.irSet, this.layout, this.binauralMode)
      : null;

    // 低音炮总线（真力 7370A）：LFE + 各主总线经低频管理分出的低频。
    // 低频无方向性，不卷积，直送双耳（与杜比/苹果双耳管线一致）。
    let subBus: GainNode | null = null;
    if (this.mode === "binaural" && this.layout.some((s) => s.isLfe)) {
      const sum = this.ctx.createGain();
      // 7370A 次声滚降（-6dB @19Hz，LR4）；上限 150Hz 由 85/120Hz 低通保证。
      const [subHpIn, subHpOut] = this.lr4("highpass", SUB_CUTOFF_HZ);
      const subOut = this.ctx.createGain();
      subOut.gain.value = 0.5;
      sum.connect(subHpIn);
      subHpOut.connect(subOut);
      subOut.connect(merger, 0, 0);
      subOut.connect(merger, 0, 1);
      this.postNodes.push(sum, subHpIn, subHpOut, subOut);
      subBus = sum;
    }

    for (let bus = 0; bus < n; bus++) {
      const spk = this.layout[bus]!;
      if (this.mode === "binaural") {
        if (spk.isLfe) {
          // LFE：ITU/杜比 120Hz LR4 低通 + 带内 +10dB，进低音炮总线。
          // 无低音炮的布局退化为等量直送双耳。
          const lfeGain = this.ctx.createGain();
          if (subBus) {
            const [lpIn, lpOut] = this.lr4("lowpass", LFE_LOWPASS_HZ);
            splitter.connect(lpIn, bus);
            lfeGain.gain.value = LFE_INBAND_GAIN;
            lpOut.connect(lfeGain);
            lfeGain.connect(subBus);
            this.postNodes.push(lpIn, lpOut, lfeGain);
          } else {
            lfeGain.gain.value = 0.5;
            splitter.connect(lfeGain, bus);
            lfeGain.connect(merger, 0, 0);
            lfeGain.connect(merger, 0, 1);
            this.postNodes.push(lfeGain);
          }
          this.convs.push(null);
          continue;
        }
        const ir = busIrs?.get(bus);
        if (ir) {
          const conv = this.ctx.createConvolver();
          conv.buffer = ir;
          conv.normalize = false;
          // 卷积输出是立体声总线；ChannelMerger 的输入是单声道，直接 connect
          // 会被 0.5(L+R) 降混 —— 必须用 splitter 把左右耳分开接线，
          // 否则整个双耳路径塌成单声道（声像全挤在中间）。
          const earSplit = this.ctx.createChannelSplitter(2);
          if (subBus) {
            // 低频管理：主音箱 85Hz LR4 高通后进卷积（The Ones + 炮的标准
            // 接法）；分出的低频进低音炮总线。
            const [hpIn, hpOut] = this.lr4("highpass", BM_CROSSOVER_HZ);
            const [lpIn, lpOut] = this.lr4("lowpass", BM_CROSSOVER_HZ);
            splitter.connect(hpIn, bus);
            splitter.connect(lpIn, bus);
            hpOut.connect(conv);
            lpOut.connect(subBus);
            this.postNodes.push(hpIn, hpOut, lpIn, lpOut);
          } else {
            splitter.connect(conv, bus);
          }
          conv.connect(earSplit);
          earSplit.connect(merger, 0, 0);
          earSplit.connect(merger, 1, 1);
          this.postNodes.push(conv, earSplit);
          this.convs.push(conv);
        } else {
          // 无 IR 资产时的优雅降级：浏览器内置 HRTF。
          const panner = this.ctx.createPanner();
          panner.panningModel = "HRTF";
          panner.distanceModel = "linear";
          panner.refDistance = 1;
          panner.maxDistance = 1;
          panner.rolloffFactor = 0;
          const [x, y, z] = sphericalToWebAudio(spk);
          panner.positionX.value = x;
          panner.positionY.value = y;
          panner.positionZ.value = z;
          const earSplit = this.ctx.createChannelSplitter(2);
          if (subBus) {
            const [hpIn, hpOut] = this.lr4("highpass", BM_CROSSOVER_HZ);
            const [lpIn, lpOut] = this.lr4("lowpass", BM_CROSSOVER_HZ);
            splitter.connect(hpIn, bus);
            splitter.connect(lpIn, bus);
            hpOut.connect(panner);
            lpOut.connect(subBus);
            this.postNodes.push(hpIn, hpOut, lpIn, lpOut);
          } else {
            splitter.connect(panner, bus);
          }
          panner.connect(earSplit);
          earSplit.connect(merger, 0, 0);
          earSplit.connect(merger, 1, 1);
          this.postNodes.push(panner, earSplit);
          this.convs.push(null);
        }
      } else {
        // "stereo": cheap downmix — weight by speaker direction.
        const gainL = this.ctx.createGain();
        const gainR = this.ctx.createGain();
        const az = (spk.azimuth * Math.PI) / 180;
        // Equal-power-ish: front-center content goes to both, sides dominate one.
        gainL.gain.value = spk.isLfe ? 0.25 : Math.max(0.05, Math.cos((az - Math.PI / 2) / 2));
        gainR.gain.value = spk.isLfe ? 0.25 : Math.max(0.05, Math.cos((az + Math.PI / 2) / 2));
        const norm = 0.7;
        gainL.gain.value *= norm;
        gainR.gain.value *= norm;
        splitter.connect(gainL, bus);
        splitter.connect(gainR, bus);
        gainL.connect(merger, 0, 0);
        gainR.connect(merger, 0, 1);
        this.postNodes.push(gainL, gainR);
      }
    }
    this.postNodes.push(splitter, merger);
  }

  /** Register a source. Bed channels pass their speaker label; objects an event id.
   *  重复声明同一 id（稀疏声明变化时 player 会重放整组）不重置用户静音状态。 */
  addSource(id: string, opts: { bedLabel?: string } = {}): void {
    if (!this.node) throw new Error("SpatialRenderer.init() first");
    const wasMuted = this.sources.get(id)?.muted ?? false;
    const state: SourceState = {
      id,
      spread: 0,
      position: { azimuth: 0, elevation: 0, distance: 1 },
      gainDb: 0,
      isLfe: opts.bedLabel ? isLfeLabel(opts.bedLabel) : false,
      muted: wasMuted,
      snapBus: -1,
    };
    if (opts.bedLabel) {
      state.position = positionForLabel(opts.bedLabel);
      // 床声道吸附：标签归一化后命中布局音箱 → 直送该音箱总线（物理直出语义），
      // 不再用 VBAP 摊到相邻音箱；布局里没有这个音箱才回退 VBAP 平移。
      if (!state.isLfe) {
        const canonical = aliasLabel(opts.bedLabel);
        state.snapBus = this.layout.findIndex((s) => s.name === canonical);
      }
    }
    this.sources.set(id, state);
    this.node.port.postMessage({ type: "add", id });
    this.applyGains(state, 0);
    if (state.snapBus >= 0) this.recomputeBedGains(id);
  }

  /** 床声道集合变化（新床声道占用/释放了扩展目标总线）→ 重推其余床声道的增益，
   *  让上混馈送跳过/恢复被真实声道占用的总线。 */
  private recomputeBedGains(excludeId: string): void {
    for (const s of this.sources.values()) {
      if (s.id !== excludeId && s.snapBus >= 0) this.applyGains(s, 512);
    }
  }

  /** 其余床声道吸附占用的总线（扩展馈送要避开）。 */
  private bedOccupiedBuses(excludeId: string): Set<number> {
    const occ = new Set<number>();
    for (const s of this.sources.values()) {
      if (s.id !== excludeId && s.snapBus >= 0) occ.add(s.snapBus);
    }
    return occ;
  }

  /** 静音/取消静音一个源（Omniphony 式对象 mute/solo 的底层原语）。
   *  走 2048 采样斜坡（@48k ≈ 43ms），切换无爆音。
   *  返回 false = 源不存在（调用方可据此提示 id 不匹配）。 */
  setSourceMuted(id: string, muted: boolean): boolean {
    const state = this.sources.get(id);
    if (!state) {
      console.warn(`[SDA] setSourceMuted 无源 "${id}"，现有源: ${[...this.sources.keys()].join(", ") || "(空)"}`);
      return false;
    }
    if (state.muted === muted) return true;
    state.muted = muted;
    this.applyGains(state, 2048);
    console.log(`[SDA] ${id} ${muted ? "静音" : "解除静音"} → scalar ${muted ? 0 : 1}`);
    return true;
  }

  removeSource(id: string): void {
    const state = this.sources.get(id);
    this.sources.delete(id);
    this.node?.port.postMessage({ type: "remove", id });
    if (state && state.snapBus >= 0) this.recomputeBedGains(id);
  }

  /** Feed PCM for a source (transferable copy recommended). */
  feed(id: string, samples: Float32Array): void {
    this.node?.port.postMessage({ type: "feed", id, samples }, [samples.buffer]);
  }

  /** Apply an object event: new position (ramped), gain, size. */
  applyEvent(ev: ObjectEvent, rampSamples: number): void {
    const state = this.sources.get(`obj:${ev.id}`);
    if (!state) return;
    if (ev.hasPos) {
      state.position = admToSpherical(ev.pos);
      state.spread = sizeToSpread(ev.size);
    }
    state.gainDb = ev.gainDb;
    this.applyGains(state, rampSamples || ev.rampDuration || 128);
  }

  /** Recompute and send a source's gain vector over the buses. */
  private applyGains(state: SourceState, rampSamples: number): void {
    const gains = this.vbap.pan(state.position, state.spread);

    // 距离增益：ADM 距离已按房间归一化（1 = 音箱环），环内一律满增益 —
    // 环内的对象响度差异交给混音师的 gainDb，渲染器不动。
    // 环外（房间角落可达 √3）按苹果 inverse 定律 1/d 衰减，并施加轻度
    // 空气吸收低通（截止 ∝ 1/d，下限 6kHz —— 保住高频瞬态，移动感不被糊掉）。
    const d = Math.max(1e-3, state.position.distance);
    let distGain = 1;
    let lp = 1; // worklet 一阶低通系数；1 = 直通
    if (d > 1) {
      distGain = 1 / d;
      const fc = Math.min(19000, Math.max(6000, 19000 / d));
      lp = 1 - Math.exp((-2 * Math.PI * fc) / this.ctx.sampleRate);
    }

    let scalar = Math.pow(10, state.gainDb / 20) * distGain;
    if (state.isLfe) {
      // LFE bypasses spatial panning: straight to the LFE bus.
      gains.fill(0);
      const lfeBus = this.layout.findIndex((s) => s.isLfe);
      if (lfeBus >= 0) gains[lfeBus] = 1;
      scalar = Math.pow(10, state.gainDb / 20);
      lp = 1;
    } else if (state.snapBus >= 0) {
      // 床声道吸附：直送同名音箱总线（AVR direct 语义）。
      // 上混扩展馈送仅用于多声道物理输出 —— 物理后环在真实房间里被房间
      // 反射去相关，听着是"填满"；而双耳/立体声里馈送是相干拷贝
      // （BRIR(100°) + 0.5·BRIR(140°) 在鼓膜处同相叠加），梳状滤波 + 声像
      // 向中间涂抹，整个声场挤成一团。AVR 上混器对派生声道做去相关，
      // 虚拟音箱域没有这个环节 —— 也不需要有：吸附已把床放到混音师
      // 本来的位置。扩展目标总线被真实床声道占用时跳过（7.1 内容的
      // 后环不吃 5.1 式馈送）。
      gains.fill(0);
      gains[state.snapBus] = 1;
      if (this.mode === "multichannel") {
        const occupied = this.bedOccupiedBuses(state.id);
        for (const e of this.expansion.get(state.snapBus) ?? []) {
          if (!occupied.has(e.bus)) gains[e.bus] = e.gain;
        }
      }
    }
    if (state.muted) scalar = 0;
    this.node?.port.postMessage({
      type: "gains",
      id: state.id,
      gains,
      gain: scalar,
      lp,
      ramp: Math.max(1, rampSamples),
    });
  }

  /** Buffered samples for a source (for buffer-level telemetry). */
  resetBuffers(): void {
    this.consumedSamples = 0;
    this.node?.port.postMessage({ type: "reset" });
  }

  /** Playhead in seconds: frames the worklet actually rendered. */
  consumedSeconds(): number {
    return this.consumedSamples / this.ctx.sampleRate;
  }

  /** Worklet-level pause: outputs silence without consuming the ring buffers,
   *  so resume continues from the exact sample. */
  setPaused(paused: boolean): void {
    this.node?.port.postMessage({ type: "pause", paused });
  }

  /** Master output volume, 0..1 (applied perceptually: gain = v²). */
  setVolume(v: number): void {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v)) ** 2;
  }

  async close(): Promise<void> {
    this.teardownPostNodes();
    this.node?.disconnect();
    this.master?.disconnect();
    if (this.ctx.state !== "closed") await this.ctx.close();
  }
}
