/**
 * Main-thread spatial renderer.
 *
 * Graph:
 *   AudioWorkletNode(sda-renderer, N-bus output)
 *     ├── "multichannel": → ctx.destination (N discrete channels)
 *     ├── "binaural":     → ChannelSplitter(N)
 *     │                     → per bus: ConvolverNode(stereo BRIR/HRIR mix)
 *     │                       (LFE: 直送双耳；无 IR 时 PannerNode HRTF 兜底)
 *     │                     → ChannelMerger(2) → ctx.destination
 *     └── "stereo":       → downmix gain matrix → merger(2) → destination
 *
 * 双耳路径遵循业界标准虚拟音箱方案（杜比 BS.2127 / Apple 虚拟化 5.1）：
 * 对象先 VBAP 到固定虚拟音箱环，每个虚拟音箱与该方向的
 * 「干 HRIR + 湿 BRIR 按模式混合」的 IR 卷积求和。卷积数固定（总线数 × 2 耳），
 * 与对象数量解耦。近/中/远（杜比 Binaural Settings）= 干/湿混合比 +
 * 参考距离；苹果式 inverse 距离定律 + 空气吸收低通在源侧（worklet）施加。
 */

import { admToSpherical, sphericalToWebAudio, type Spherical } from "./coords.js";
import { LAYOUT_7_1_4, positionForLabel, isLfeLabel, type VirtualSpeaker } from "./layouts.js";
import { VbapSolver } from "./vbap.js";
import { buildBusIrs, type BinauralIrSet, type BinauralMode } from "./hrtf.js";
import type { ObjectEvent } from "@sda/core";

export type OutputMode = "multichannel" | "binaural" | "stereo";

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
  /** 杜比 Binaural Settings 语义：虚拟音箱距离 近0.7m / 中1.2m / 远2.5m。 */
  private binauralMode: BinauralMode = "mid";
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

  private buildOutputGraph(): void {
    if (!this.node || !this.master) return;
    this.teardownPostNodes();
    const n = this.layout.length;

    if (this.mode === "multichannel") {
      this.node.connect(this.master);
      return;
    }

    const splitter = this.ctx.createChannelSplitter(n);
    this.node.connect(splitter);
    const merger = this.ctx.createChannelMerger(2);
    merger.connect(this.master);

    const busIrs = this.mode === "binaural" && this.irSet
      ? buildBusIrs(this.ctx, this.irSet, this.layout, this.binauralMode)
      : null;

    for (let bus = 0; bus < n; bus++) {
      const spk = this.layout[bus]!;
      if (this.mode === "binaural") {
        if (spk.isLfe) {
          // LFE 无方向性（低频不可定位）：等量直送双耳。
          const g = this.ctx.createGain();
          g.gain.value = 0.5;
          splitter.connect(g, bus);
          g.connect(merger, 0, 0);
          g.connect(merger, 0, 1);
          this.postNodes.push(g);
          this.convs.push(null);
          continue;
        }
        const ir = busIrs?.get(bus);
        if (ir) {
          const conv = this.ctx.createConvolver();
          conv.buffer = ir;
          conv.normalize = false;
          splitter.connect(conv, bus);
          conv.connect(merger, 0, 0);
          conv.connect(merger, 0, 1);
          this.postNodes.push(conv);
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
          splitter.connect(panner, bus);
          panner.connect(merger, 0, 0);
          panner.connect(merger, 0, 1);
          this.postNodes.push(panner);
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

  /** Register a source. Bed channels pass their speaker label; objects an event id. */
  addSource(id: string, opts: { bedLabel?: string } = {}): void {
    if (!this.node) throw new Error("SpatialRenderer.init() first");
    const state: SourceState = {
      id,
      spread: 0,
      position: { azimuth: 0, elevation: 0, distance: 1 },
      gainDb: 0,
      isLfe: opts.bedLabel ? isLfeLabel(opts.bedLabel) : false,
    };
    if (opts.bedLabel) {
      state.position = positionForLabel(opts.bedLabel);
    }
    this.sources.set(id, state);
    this.node.port.postMessage({ type: "add", id });
    this.applyGains(state, 0);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
    this.node?.port.postMessage({ type: "remove", id });
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
    }
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
