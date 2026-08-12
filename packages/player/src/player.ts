/**
 * SdaPlayer — glues everything together:
 *
 *   file/stream ──push──▶ decoder worker (demux + wasm decode)
 *                         │  DecodedFrameData (PCM + events)
 *                         ▼
 *                    SpatialRenderer (AudioWorklet, VBAP → buses → out)
 *                         │
 *                         ▼ onVisualState (throttled) → 3D visualization
 *
 * Timing model: decoded PCM is pushed into per-source ring buffers ahead of
 * the playhead; `samplePos` on frames is the authoritative stream clock.
 * The player paces pushes so the renderer stays ~TARGET_AHEAD_SECONDS ahead.
 */

import {
  SpatialRenderer,
  getBinauralIrSet,
  headphoneProfileById,
  registerLocalHeadphoneCompensation,
  unregisterLocalHeadphoneCompensation,
  type LocalHeadphoneCompensationData,
  type BinauralMode,
  type BinauralEqBands,
  type OutputMode,
  type VirtualSpeaker,
} from "@sda/renderer";
import type { DecodedFrameData, ObjectChannelDecl, ObjectEvent } from "@sda/core";
import type { BinauralRenderMetadata, BinauralRenderMode } from "@sda/demux";
import { placeholderVisualObject, visualObjectFromEvent } from "./control.js";

export interface VisualObject {
  id: number;
  pos: [number, number, number]; // ADM cartesian
  hasPos: boolean;
  size: [number, number, number];
  gainDb: number;
  anchor: "room" | "screen" | "speaker";
  distanceM: number | null;
  distanceInfinite: boolean;
}

export interface PlayerCallbacks {
  onTrack?: (info: { codec: string; sampleRate: number; channels: number; container: string; durationSec?: number; title?: string; coverArt?: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" } }) => void;
  /** Program-level DBMD metadata. It never follows the sample event timeline. */
  onBinauralMetadata?: (metadata: BinauralRenderMetadata) => void;
  onBinauralObjectModes?: (modes: ReadonlyMap<number, BinauralRenderMode>) => void;
  /** Decoded frame topology. Container channel_count can describe only an EC-3 core. */
  onDecodedFormat?: (info: { rawBedLabels: string[]; bedLabels: string[]; objectChannels: number }) => void;
  /** Throttled (~per frame batch) object-state snapshot for the 3D view. */
  onVisualState?: (objects: VisualObject[], streamTimeSec: number) => void;
  onError?: (message: string) => void;
  /** Fired when the input ended and the renderer drained. */
  onEnded?: () => void;
}

/** 按码流内容推断渲染布局（自动布局模式）。返回 null = 保持当前布局。 */
export type LayoutResolver = (
  bedLabels: readonly string[],
  hasDynamics: boolean,
) => readonly VirtualSpeaker[] | null;

const TARGET_AHEAD_SECONDS = 2;
const STARTUP_AHEAD_SECONDS = 0.5;
const MAX_IN_FLIGHT_BATCHES = 32;
const MAX_IN_FLIGHT_SECONDS = 0.25;
const CHUNK_SIZE = 1 << 20; // 1 MiB reads

export class SdaPlayer {
  /** 当前活跃实例。防止 HMR / 异常路径泄漏的旧 AudioContext 继续发声：
   *  新实例 init 时强制 dispose 上一个。 */
  private static active: SdaPlayer | null = null;
  private static nextId = 1;
  /** 实例序号，用于诊断"界面控制的实例"和"实际发声的实例"是否一致。 */
  readonly id = SdaPlayer.nextId++;

  private worker: Worker;
  private renderer: SpatialRenderer | null = null;
  private cb: PlayerCallbacks;
  private readyResolve!: () => void;
  private ready: Promise<void>;
  private objectChannels = new Map<number, number>(); // object id → PCM channel
  private decodedFormatKey = "";
  private trackReported = false;
  private knownBedLabels: string[] = [];
  private acceptedEndSample = 0;
  private startupOrigin: number | null = null;
  private startupAcceptedEnd = 0;
  private playbackStarted = false;
  private nextBatchSequence = 1;
  private inFlight = new Map<number, { sequence: number; frame: DecodedFrameData; samples: number }>();
  private submittedFrames = new Set<DecodedFrameData>();
  private batchResults = new Map<DecodedFrameData, { accepted: boolean; samples: number; reason?: string }>();
  /** 已解码但尚未喂入 worklet 的帧队列（背压：环形缓冲只有 ~5.5s，
   *  直接灌会被静默丢弃，必须按播放头消耗速度泵入）。 */
  private pcmQueue: DecodedFrameData[] = [];
  private queuedSamples = 0;
  /** 容器头部元数据给出的真实总时长（裸流没有，回退到已解码时长）。 */
  private containerDurationSec: number | null = null;
  private sampleRate = 48000;
  private objects = new Map<number, VisualObject>();
  /** DBMD is static program metadata and is intentionally never sample-scheduled. */
  private binauralMetadata: BinauralRenderMetadata | null = null;
  private objectBinauralModes = new Map<number, BinauralRenderMode>();
  /** Visual metadata waits for the same codec sample clock as audio gains. */
  private pendingVisualEvents: ObjectEvent[] = [];
  private visualTimer: ReturnType<typeof setInterval> | null = null;
  private ended = false;
  /** init 参数快照，重建 AudioContext（采样率对齐）时用。 */
  private initArgs: {
    mode: OutputMode;
    workletUrl: string | URL;
    layout?: readonly VirtualSpeaker[];
    binauralBaseUrl: string;
    layoutResolver?: LayoutResolver;
  } | null = null;
  /** 是否已按码流内容做过布局自动检测（每次播放只检测一次）。 */
  private layoutChecked = false;
  /** 用户选择的最终双耳三段 EQ；renderer 重建后恢复。 */
  private binauralEqBands: BinauralEqBands = { low: 0, mid: 0, high: 0 };
  /** 上次布局检测时是否已有动态对象（对象迟到的码流允许再检测一次）。 */
  private layoutHadDynamics = false;
  /** renderer 重建串行链：采样率对齐与布局自动检测可能在同一帧同时
   *  触发，并发跑 recreateRenderer 会泄漏 AudioContext —— 必须排队。 */
  private recreateChain: Promise<void> = Promise.resolve();
  private lastVolume = 1;
  /** 杜比 Binaural Settings（近/中/远），重建 renderer 后需恢复。
   *  UI 固定"近"，mid/far 暂不从界面暴露。 */
  private binauralMode: BinauralMode = "near";
  /** 被静音的对象事件 id（Omniphony 式 mute/solo）；重建 renderer 后恢复。 */
  private mutedObjects = new Set<number>();
  /** 独立 LFE 床声道的静音状态，renderer 重建后恢复。 */
  private lfeMuted = false;
  /** 自动布局在用户手动选择后暂停，切回 Auto 时恢复。 */
  private autoLayoutEnabled = true;
  /** 仅真实测量曲线可选；当前 registry 为空，null = 最终输出 literal bypass。 */
  private headphoneProfileId: string | null = null;
  /** 是否已按码流采样率校准过 AudioContext（每次播放只校准一次）。 */
  private rateChecked = false;
  private lastUnderrunReport = 0;
  private disposed = false;

  constructor(cb: PlayerCallbacks = {}) {
    this.cb = cb;
    this.worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise<void>((res) => (this.readyResolve = res));
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => this.handleWorkerFailure(`解码 worker 异常：${e.message || "未知错误"}`);
    this.worker.onmessageerror = () => this.handleWorkerFailure("解码 worker 消息传输失败");
  }

  async init(mode: OutputMode, workletUrl: string | URL, layout?: readonly VirtualSpeaker[], binauralBaseUrl = "/hrtf", layoutResolver?: LayoutResolver): Promise<void> {
    console.log(`[SDA] player#${this.id} init (active=#${SdaPlayer.active?.id ?? "-"})`);
    if (SdaPlayer.active && SdaPlayer.active !== this) {
      console.warn(`[SDA] player#${this.id} 强制销毁泄漏的 player#${SdaPlayer.active.id}`);
      void SdaPlayer.active.dispose();
    }
    SdaPlayer.active = this;
    this.initArgs = { mode, workletUrl, layout, binauralBaseUrl, layoutResolver };
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.renderer = new SpatialRenderer(ctx, {
      mode,
      layout,
      onConsumedTick: (stats) => {
        this.reportRendererHealth(stats);
        this.pumpPcm();
      },
      onBatchResult: (result) => this.handleBatchResult(result),
    });
    await this.renderer.init(workletUrl);
    this.renderer.setHeadphoneCompensation(this.headphoneProfileId);
    this.renderer.setBinauralEqBands(this.binauralEqBands);
    await this.attachBinauralIrs(this.renderer);
    this.worker.postMessage({ type: "init" });
    await this.ready;
  }

  /** 加载双耳 IR 集（SADIE II KU100）并注入渲染器。失败时优雅降级到
   *  浏览器内置 HRTF（PannerNode），播放不受影响。原始数据跨 AudioContext
   *  缓存，采样率对齐重建时不会重复下载。 */
  private async attachBinauralIrs(r: SpatialRenderer): Promise<void> {
    try {
      const baseUrl = this.initArgs?.binauralBaseUrl;
      if (!baseUrl) return;
      const set = await getBinauralIrSet(baseUrl);
      if (this.disposed || this.renderer !== r) return;
      r.setBinauralData(set);
      r.setBinauralMode(this.binauralMode);
      console.log(`[SDA] player#${this.id} 双耳 IR 已加载（${set.positions.length} 方向 @${set.sampleRate}Hz）`);
    } catch (e) {
      console.warn(`[SDA] player#${this.id} 双耳 IR 资产缺失，回退浏览器内置 HRTF（先跑 node scripts/build-hrtf.mjs）`, e);
    }
  }

  /** 播放中仅替换逻辑扬声器布局；不重建 AudioContext/worklet，不清 PCM 缓冲。 */
  setLayout(layout: readonly VirtualSpeaker[], manual = true): void {
    if (!this.initArgs) return;
    if (manual) this.autoLayoutEnabled = false;
    this.initArgs.layout = layout;
    this.renderer?.setLayout(layout);
  }

  /** 恢复按当前码流信息自动选择布局。 */
  setAutoLayout(): void {
    const resolver = this.initArgs?.layoutResolver;
    if (!resolver) return;
    this.autoLayoutEnabled = true;
    const hasDyn = this.objectChannels.size > 0;
    const next = resolver(this.knownBedLabels, hasDyn);
    if (next) this.setLayout(next, false);
    this.layoutChecked = true;
    this.layoutHadDynamics = hasDyn;
  }

  /** 播放中实时交叉淡化最终输出模式，保留 decoder/worklet/PCM 与所有 source 状态。 */
  setOutputMode(mode: OutputMode): void {
    if (!this.initArgs) return;
    this.initArgs.mode = mode;
    this.renderer?.setOutputMode(mode);
  }

  get outputMode(): OutputMode | null {
    return this.renderer?.outputMode ?? this.initArgs?.mode ?? null;
  }

  /** 切换杜比近/中/远（播放中实时生效）。 */
  setBinauralMode(mode: BinauralMode): void {
    this.binauralMode = mode;
    this.renderer?.setBinauralMode(mode);
  }

  /** 注册主进程已校验的本地左右 FIR。选中该 profile 时只切最终双耳 EQ，
   * 不重建 decoder/worklet/PCM。 */
  registerLocalHeadphoneCompensation(data: LocalHeadphoneCompensationData): void {
    registerLocalHeadphoneCompensation(data);
  }

  /** 移除本地档案。若它正在使用，先回到 literal bypass。 */
  unregisterLocalHeadphoneCompensation(profileId: string): boolean {
    if (this.headphoneProfileId === profileId) this.setHeadphoneCompensation(null);
    return unregisterLocalHeadphoneCompensation(profileId);
  }

  /** 设置最终双耳耳机补偿。profile 必须来自 renderer 注册的真实测量曲线。 */
  setHeadphoneCompensation(profileId: string | null): void {
    if (profileId !== null && !headphoneProfileById(profileId)) {
      throw new Error(`未知或未注册的耳机补偿 profile: ${profileId}`);
    }
    this.headphoneProfileId = profileId;
    this.renderer?.setHeadphoneCompensation(profileId);
  }

  get headphoneCompensationProfileId(): string | null {
    return this.headphoneProfileId;
  }

  /** 设置最终双耳的低、中、高三段 EQ，不改变空间化或耳机补偿 FIR。 */
  setBinauralEqBands(bands: BinauralEqBands): void {
    this.binauralEqBands = bands;
    this.renderer?.setBinauralEqBands(bands);
  }

  get binauralEq(): Readonly<BinauralEqBands> {
    return this.binauralEqBands;
  }

  /** 静音/取消静音一个对象（Omniphony 式 per-object mute 原语；
   * solo 由 UI 层用“mute 其他全部”组合实现）。对象尚未声明时只记录状态，
   * 声源声明到达/renderer 重建时自动应用。 */
  setObjectMuted(objectId: number, muted: boolean): void {
    if (muted) this.mutedObjects.add(objectId);
    else this.mutedObjects.delete(objectId);
    if (!this.renderer || !this.objectChannels.has(objectId)) return;
    if (!this.renderer.setSourceMuted(`obj:${objectId}`, muted)) {
      this.cb.onError?.(`静音未命中：obj:${objectId} 已声明但渲染器无此声源`);
    }
  }

  /** 原子同步整组对象静音状态，避免 React state、首帧声明和 renderer
   * 初始化之间的时序竞争。未声明对象只保存在 mutedObjects，等声明到达时应用。 */
  syncObjectMutes(mutedIds: ReadonlySet<number>): void {
    this.mutedObjects = new Set(mutedIds);
    for (const id of this.objectChannels.keys()) {
      if (this.renderer) this.renderer.setSourceMuted(`obj:${id}`, mutedIds.has(id));
    }
  }

  /** 静音/恢复独立 LFE 床声道；状态会跨 renderer 重建保留。 */
  setLfeMuted(muted: boolean): void {
    this.lfeMuted = muted;
    this.renderer?.setLfeMuted(muted);
  }

  /** 码流采样率与 AudioContext 不一致时（如 48k 码流 vs 44.1k 声卡）
   *  重建 AudioContext —— 否则按错误速率播放 = 变慢/降调。
   *  只在音轨发现/首帧时调用一次，此时环形缓冲还没喂数据，切换无损。 */
  private ensureStreamRate(rate: number): void {
    if (this.rateChecked || !this.renderer || !this.initArgs) return;
    this.rateChecked = true;
    if (!Number.isFinite(rate) || rate <= 0) return;
    if (Math.abs(this.renderer.ctx.sampleRate - rate) < 1) return;
    console.log(`[SDA] player#${this.id} 采样率不匹配：ctx=${this.renderer.ctx.sampleRate} 码流=${rate}，重建 AudioContext`);
    this.scheduleRecreate(rate);
  }

  /** 排队重建 renderer（采样率对齐 / 布局自动检测可能在同一帧同时触发，
   *  并发跑 recreateRenderer 会泄漏 AudioContext —— 必须串行）。
   *  recreatePending 期间 pumpPcm 停止喂入：喂给旧 worklet 的帧随旧
   *  AudioContext 关闭整段丢失，攒在队列里才能无损切换。 */
  private recreatePending = 0;

  private scheduleRecreate(sampleRate: number, layout?: readonly VirtualSpeaker[]): void {
    if (layout && this.initArgs) this.initArgs.layout = layout;
    this.recreatePending++;
    this.recreateChain = this.recreateChain
      .then(() => this.recreateRenderer(sampleRate))
      .catch((e) => console.warn(`[SDA] player#${this.id} renderer 重建失败`, e));
  }

  private async recreateRenderer(sampleRate: number): Promise<void> {
    try {
      const { mode, workletUrl, layout } = this.initArgs!;
      const old = this.renderer;
      this.inFlight.clear();
      this.submittedFrames.clear();
      this.batchResults.clear();
      this.renderer = null; // pump/feed 暂停，帧在队列里堆积
      await old?.close();
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ latencyHint: "playback", sampleRate });
      } catch {
        // 设备不接受该采样率：退回默认速率（仍会变速，但优于无声）
        ctx = new AudioContext({ latencyHint: "playback" });
      }
      const r = new SpatialRenderer(ctx, {
        mode,
        layout,
        onConsumedTick: (stats) => {
          this.reportRendererHealth(stats);
          this.pumpPcm();
        },
        onBatchResult: (result) => this.handleBatchResult(result),
      });
      await r.init(workletUrl);
      if (this.disposed) {
        await r.close();
        return;
      }
      r.setVolume(this.lastVolume);
      r.setHeadphoneCompensation(this.headphoneCompensationProfileId);
      r.setBinauralEqBands(this.binauralEqBands);
      r.setLfeMuted(this.lfeMuted);
      this.renderer = r;
      // 恢复暂停意图：重建的 worklet 默认不暂停、新 AudioContext 默认 running，
      // 不恢复的话暂停中重建会让音频自己继续响（UI 仍显示暂停，按钮看似失效）
      if (this.pausedState) {
        r.setPaused(true);
        void r.ctx.suspend().catch(() => {});
      } else {
        await r.ctx.resume();
      }
      // 采样率对齐重建后：重新注入双耳 IR（原始数据有缓存，不会重复下载）
      void this.attachBinauralIrs(r);
      // 床层/对象源在新 worklet 里重新声明
      this.knownBedLabels = [];
      for (const id of this.objectChannels.keys()) {
        r.addSource(`obj:${id}`);
        const mode = this.objectBinauralModes.get(id);
        if (mode) r.setSourceBinauralMode(`obj:${id}`, mode);
      }
      // 新 renderer 中恢复对象静音状态。
      for (const id of this.mutedObjects) r.setSourceMuted(`obj:${id}`, true);
    } finally {
      this.recreatePending--;
      if (this.recreatePending === 0) {
        // 新 worklet 的 consumed 从 0 起计，fedSamples 同步归零 —— 否则
        // fedBufferedSeconds 虚高 TARGET 秒，pump 停摆数秒（表现为开播卡死）。
        // 此刻才喂入的帧全部来自队列，播放内容无损。
        this.acceptedEndSample = 0;
        this.inFlight.clear();
        this.submittedFrames.clear();
        this.batchResults.clear();
        this.resetStartupGate();
        this.pumpPcm();
      }
    }
  }

  get audioContext(): AudioContext | null {
    return this.renderer?.ctx ?? null;
  }

  /** Play a File/Blob (browser) end-to-end. */
  async playFile(file: Blob, codec: "auto" | "truehd" | "eac3" | "dts" = "auto"): Promise<void> {
    if (!this.renderer) throw new Error("call init() first");
    await this.renderer.ctx.resume();
    console.log(`[SDA] player#${this.id} playFile`);
    this.worker.postMessage({ type: "open", codec });

    this.visualTimer = setInterval(() => this.emitVisual(), 66);

    const stream = file.stream();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.worker.postMessage({ type: "push", chunk: value.buffer }, [value.buffer]);
      await this.pace();
    }
    this.worker.postMessage({ type: "flush" });
  }

  /** Push raw bytes manually (Electron fs stream / network fetch). */
  open(codec: "auto" | "truehd" | "eac3" | "dts" = "auto"): void {
    this.worker.postMessage({ type: "open", codec });
    this.visualTimer ??= setInterval(() => this.emitVisual(), 66);
  }

  async push(chunk: Uint8Array): Promise<void> {
    const copy = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    this.worker.postMessage({ type: "push", chunk: copy }, [copy]);
    await this.pace();
  }

  /** Signal end of a manually pushed stream and drain remaining demuxed PCM. */
  end(): void {
    this.worker.postMessage({ type: "flush" });
  }

  stop(): void {
    if (this.visualTimer) clearInterval(this.visualTimer);
    this.visualTimer = null;
    this.renderer?.resetBuffers();
    // addSource 对同一曲目内的稀疏重声明必须幂等；曲目边界则显式删除源，
    // 避免下一首复用相同 bed:ch/obj:id 时继承上一首的位置、增益或床标签。
    this.knownBedLabels.forEach((label, channel) => {
      if (!label.startsWith("Obj_")) this.renderer?.removeSource(`bed:${channel}`);
    });
    for (const id of this.objectChannels.keys()) this.renderer?.removeSource(`obj:${id}`);
    this.knownBedLabels = [];
    // 若暂停中停止，同时解除 worklet 静音和时钟挂起，避免卡死
    this.pausedState = false;
    this.renderer?.setPaused(false);
    void this.renderer?.ctx.resume();
    this.objects.clear();
    this.binauralMetadata = null;
    this.objectBinauralModes.clear();
    this.pendingVisualEvents = [];
    this.objectChannels.clear();
    this.decodedFormatKey = "";
    this.emitVisual();
    this.acceptedEndSample = 0;
    this.inFlight.clear();
    this.submittedFrames.clear();
    this.batchResults.clear();
    this.resetStartupGate();
    this.pcmQueue = [];
    this.queuedSamples = 0;
    this.containerDurationSec = null;
    this.trackReported = false;
    this.ended = false;
    this.rateChecked = false;
    this.layoutChecked = false;
    this.layoutHadDynamics = false;
    this.autoLayoutEnabled = true;
  }

  /** Pause: silence the worklet (buffer-preserving) AND suspend the clock.
   *  The worklet mute alone is sufficient — its consumed counter freezes,
   *  so the playhead stops with it. suspend() is a best-effort backup.
   *  暂停意图记录在 pausedState：renderer 重建（采样率对齐/布局自动检测）
   *  或重建进行中（renderer 暂为 null）时暂停不丢失，recreateRenderer 恢复。 */
  private pausedState = false;

  async pause(): Promise<void> {
    this.pausedState = true;
    if (!this.renderer) return;
    console.log(`[SDA] player#${this.id} pause @${this.renderer.consumedSeconds().toFixed(2)}s`);
    this.renderer.setPaused(true);
    try {
      await this.renderer.ctx.suspend();
    } catch {
      /* suspend 在某些环境不可靠；worklet 硬暂停已足够 */
    }
  }

  async resume(): Promise<void> {
    this.pausedState = false;
    if (!this.renderer) return;
    console.log(`[SDA] player#${this.id} resume`);
    this.renderer.setPaused(false);
    try {
      await this.renderer.ctx.resume();
    } catch {
      /* ignore */
    }
  }

  setVolume(v: number): void {
    this.lastVolume = v;
    this.renderer?.setVolume(v);
  }

  async dispose(): Promise<void> {
    console.log(`[SDA] player#${this.id} dispose`);
    this.disposed = true;
    this.stop();
    this.worker.terminate();
    await this.renderer?.close();
    if (SdaPlayer.active === this) SdaPlayer.active = null;
  }

  /** Playhead in seconds: frames the worklet actually rendered.
   *  Immune to AudioContext clock drift / suspend weirdness; freezes on pause.
   *  Clamped to the fed duration — after the stream ends the worklet keeps
   *  rendering silence blocks and its counter would otherwise run past the
   *  end of the song. */
  positionSeconds(): number {
    if (!this.renderer) return 0;
    return Math.min(this.renderer.consumedSeconds(), this.durationSeconds());
  }

  durationSeconds(): number {
    return this.containerDurationSec ?? Math.max(0, this.acceptedEndSample - (this.startupOrigin ?? 0)) / this.sampleRate;
  }

  // ---- internals ----

  private resetStartupGate(): void {
    this.startupOrigin = null;
    this.startupAcceptedEnd = 0;
    this.playbackStarted = false;
  }

  private startPlaybackIfReady(force = false): void {
    if (this.playbackStarted || this.startupOrigin === null) return;
    const required = Math.min(STARTUP_AHEAD_SECONDS, this.renderer?.maxBufferedSeconds() ?? STARTUP_AHEAD_SECONDS) * this.sampleRate;
    if (!force && this.startupAcceptedEnd - this.startupOrigin < required) return;
    this.renderer?.startAt(this.startupOrigin);
    this.playbackStarted = true;
  }

  private commitBatchResults(): void {
    while (this.pcmQueue.length > 0) {
      const frame = this.pcmQueue[0]!;
      const result = this.batchResults.get(frame);
      if (!result) break;
      this.batchResults.delete(frame);
      this.submittedFrames.delete(frame);
      this.pcmQueue.shift();
      const samples = frame.channels[0]?.length ?? 0;
      this.queuedSamples -= samples;
      if (!result.accepted) {
        this.cb.onError?.(`PCM frame 被 worklet 跳过：${result.reason ?? "unknown"}`);
        continue;
      }
      const end = frame.samplePos + result.samples;
      this.acceptedEndSample = Math.max(this.acceptedEndSample, end);
      if (!this.playbackStarted) {
        this.startupOrigin ??= frame.samplePos;
        this.startupAcceptedEnd = Math.max(this.startupAcceptedEnd, end);
      }
    }
    this.startPlaybackIfReady();
  }

  private handleBatchResult(result: { sequence: number; accepted: boolean; samples: number; reason?: string }): void {
    const pending = this.inFlight.get(result.sequence);
    if (!pending) return;
    this.inFlight.delete(result.sequence);
    if (!result.accepted && result.reason === "ring-full") {
      this.submittedFrames.delete(pending.frame);
    } else {
      this.batchResults.set(pending.frame, result);
    }
    this.commitBatchResults();
    this.pumpPcm();
  }

  private targetAheadSeconds(): number {
    return Math.min(TARGET_AHEAD_SECONDS, this.renderer?.maxBufferedSeconds() ?? TARGET_AHEAD_SECONDS);
  }

  private reportRendererHealth(stats: { underrunSamples: number; rejectedBatches: number; rejectedSources: number }): void {
    if (stats.underrunSamples === 0 && stats.rejectedBatches === 0 && stats.rejectedSources === 0) return;
    const now = performance.now();
    if (now - this.lastUnderrunReport < 1000) return;
    this.lastUnderrunReport = now;
    const details = [
      stats.underrunSamples ? `断供 ${stats.underrunSamples} samples` : "",
      stats.rejectedBatches ? `拒绝 ${stats.rejectedBatches} PCM frame` : "",
      stats.rejectedSources ? `拒绝 ${stats.rejectedSources} source` : "",
      `缓冲 ${Math.max(0, this.fedBufferedSeconds()).toFixed(2)}s`,
    ].filter(Boolean).join("，");
    this.cb.onError?.(`音频实时供给不足：${details}`);
  }

  private async pace(): Promise<void> {
    // renderer 为 null（重建中）也要继续节流：queuedSamples 仍在累计，
    // 否则整个文件会在重建窗口内灌进 worker 解码（帧随即因 renderer 缺席堆积，
    // 缓冲爆炸）。disposed 时退出避免死等。
    while (!this.disposed && this.aheadSeconds() > this.targetAheadSeconds()) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private aheadSeconds(): number {
    // 读取节流看的是"已解码但未播出"总量 = 队列里的 + 环形缓冲里的。
    return this.queuedSamples / this.sampleRate + this.fedBufferedSeconds();
  }

  private handleWorkerFailure(message: string): void {
    if (this.disposed) return;
    this.cb.onError?.(message);
    this.ended = true;
    this.pcmQueue = [];
    this.queuedSamples = 0;
    this.checkEnded();
  }

  private onWorkerMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve();
        break;
      case "track": {
        this.trackReported = true;
        const track = msg.track as { codec: string; sampleRate: number; channels: number; container: string; durationSec?: number; title?: string; coverArt?: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" } };
        if (track.durationSec && Number.isFinite(track.durationSec)) {
          this.containerDurationSec = track.durationSec;
        }
        this.ensureStreamRate(track.sampleRate);
        this.cb.onTrack?.(track);
        break;
      }
      case "binaural-metadata": {
        this.binauralMetadata = msg.metadata as BinauralRenderMetadata;
        this.objectBinauralModes.clear();
        this.cb.onBinauralMetadata?.(this.binauralMetadata);
        break;
      }
      case "frame":
        this.handleFrame(msg.frame as DecodedFrameData);
        break;
      case "flushed":
        this.ended = true;
        this.startPlaybackIfReady(true);
        this.checkEnded();
        break;
      case "error":
        this.cb.onError?.(String(msg.message));
        break;
    }
  }

  private handleFrame(frame: DecodedFrameData): void {
    // 注意：renderer 为 null（重建窗口中）也不能 return —— 帧必须照样排队，
    // 否则窗口内解码的帧被静默丢弃（采样率对齐重建 + pace 同时失灵时，
    // 整个文件会在窗口内解完扔光 → 提前 onEnded，卡在第几秒）。
    // pumpPcm 自己有 null 守卫，队列在重建完成后继续泵。
    this.sampleRate = frame.sampleRate;

    // Raw elementary streams never fire the demuxer's onTrack — derive the
    // panel info from the first decoded frame instead.
    if (!this.trackReported) {
      this.trackReported = true;
      this.ensureStreamRate(frame.sampleRate);
      this.cb.onTrack?.({
        codec: frame.codec,
        sampleRate: frame.sampleRate,
        channels: frame.channels.length,
        container: "raw",
      });
    }

    // 解码帧先排队，由 pumpPcm 按播放头消耗速度喂入 worklet —
    // 直接灌会撑爆 ~5.5s 的环形缓冲，超出的音频被静默丢弃。
    this.pcmQueue.push(frame);
    this.queuedSamples += frame.channels[0]?.length ?? 0;
    this.pumpPcm();
    this.checkEnded();
  }

  private submittedEndSample(): number {
    let end = this.acceptedEndSample;
    for (const pending of this.inFlight.values()) end = Math.max(end, pending.frame.samplePos + pending.samples);
    return end;
  }

  private submittedBufferedSeconds(): number {
    const origin = this.startupOrigin ?? this.pcmQueue[0]?.samplePos ?? 0;
    const cursor = this.playbackStarted ? (this.renderer?.consumedSamples ?? origin) : origin;
    return Math.max(0, this.submittedEndSample() - cursor) / this.sampleRate;
  }

  /** 把队列里的帧泵入 worklet 环形缓冲，保持喂入量领先播放头 ~TARGET 秒。 */
  private pumpPcm(): void {
    if (!this.renderer || this.recreatePending > 0) return;
    let outstandingSamples = [...this.inFlight.values()].reduce((sum, pending) => sum + pending.samples, 0);
    while (
      this.inFlight.size < MAX_IN_FLIGHT_BATCHES &&
      outstandingSamples < MAX_IN_FLIGHT_SECONDS * this.sampleRate &&
      this.submittedBufferedSeconds() <= this.targetAheadSeconds()
    ) {
      const frame = this.pcmQueue.find((candidate) => !this.submittedFrames.has(candidate));
      if (!frame) break;
      const frameSamples = frame.channels[0]?.length ?? 0;

      // (Re)declare bed sources when labels change.
      if (frame.labels.join() !== this.knownBedLabels.join()) {
        this.knownBedLabels = frame.labels;
        frame.labels.forEach((label, ch) => {
          if (!label.startsWith("Obj_")) {
            this.renderer!.addSource(`bed:${ch}`, { bedLabel: label });
          }
        });
      }

      // Sparse object↔channel declaration. An all-fixed frame (no Obj_ labels)
      // is an explicit presentation transition, not an unchanged sparse frame:
      // drop old object routes so a later bed PCM channel cannot inherit a stale
      // moving-object binding after an invalid/missing JOC↔OAMD mapping.
      const hasObjectLabels = frame.labels.some((label) => label.startsWith("Obj_"));
      let visualChanged = false;
      if (!hasObjectLabels) {
        this.objectChannels.clear();
        if (this.objects.size > 0) {
          this.objects.clear();
          visualChanged = true;
        }
      }

      const declarations = frame.objectChannels as ObjectChannelDecl[];
      const bedLabels = frame.labels.filter((label) => !label.startsWith("Obj_"));
      // Object declarations are sparse after their first frame. Labels remain on
      // every PCM frame, so they are the durable decoded-format signal for UI.
      const objectChannelCount = frame.labels.filter((label) => label.startsWith("Obj_")).length;
      const decodedFormatKey = `${frame.rawBedLabels.join(",")}|${bedLabels.join(",")}|${objectChannelCount}`;
      if (decodedFormatKey !== this.decodedFormatKey) {
        this.decodedFormatKey = decodedFormatKey;
        this.cb.onDecodedFormat?.({ rawBedLabels: frame.rawBedLabels, bedLabels, objectChannels: objectChannelCount });
      }
      if (declarations.length > 0) {
        // A non-empty sparse declaration is the complete replacement mapping,
        // not a patch. Replacing it prevents stale IDs/channels after a track
        // change or a presentation switch.
        this.objectChannels.clear();
        const declaredIds = new Set<number>();
        for (const [ordinal, decl] of declarations.entries()) {
          declaredIds.add(decl.id);
          this.objectChannels.set(decl.id, decl.channel);
          this.renderer.addSource(`obj:${decl.id}`);
          const mode = this.binauralMetadata?.available ? this.binauralMetadata.objectModes[ordinal] : undefined;
          if (mode) {
            this.objectBinauralModes.set(decl.id, mode);
            this.renderer.setSourceBinauralMode(`obj:${decl.id}`, mode);
          }
          // 声明可能是整组重放；addSource 对已有 id 幂等，此处只同步独立
          // mute 包络，不触碰该源已经排队/生效的位置、增益等元数据。
          this.renderer.setSourceMuted(`obj:${decl.id}`, this.mutedObjects.has(decl.id));
          if (!this.objects.has(decl.id)) {
            // OAMD events may arrive in a later frame. Expose the object now so
            // the first opened file does not appear to have no objects.
            this.objects.set(decl.id, placeholderVisualObject(decl.id));
            visualChanged = true;
          }
        }
        for (const id of this.objects.keys()) {
          if (!declaredIds.has(id)) {
            this.objects.delete(id);
            visualChanged = true;
          }
        }
        this.cb.onBinauralObjectModes?.(this.objectBinauralModes);
      }
      const channelToObject = new Map<number, number>();
      for (const [id, ch] of this.objectChannels) channelToObject.set(ch, id);

      // 自动布局只替换逻辑增益映射；worklet/PCM 缓冲和播放头保持连续。
      // 对象声明迟到的码流同样不会再触发 AudioContext 重建。
      const resolver = this.initArgs?.layoutResolver;
      const hasDyn = this.objectChannels.size > 0;
      if (this.autoLayoutEnabled && resolver && (!this.layoutChecked || (!this.layoutHadDynamics && hasDyn))) {
        this.layoutChecked = true;
        this.layoutHadDynamics = hasDyn;
        const next = resolver(frame.labels, hasDyn);
        const cur = this.initArgs?.layout;
        const same =
          next && cur && next.length === cur.length && next.every((s, i) => s.name === cur[i]!.name);
        if (next && !same) {
          console.log(
            `[SDA] player#${this.id} 布局自动检测 → ${next.length} 音箱（${hasDyn ? "含动态对象" : "纯床层"}），保持播放切换`,
          );
          this.setLayout(next, false);
        }
      }

      // Schedule metadata before exposing this frame to the worklet. Port
      // messages are FIFO, so the first sample can never render with a future
      // or stale object position merely because the player prebuffers ~2 s.
      for (const ev of frame.events as ObjectEvent[]) {
        this.renderer.applyEvent(ev, ev.rampDuration || 128);
        this.pendingVisualEvents.push(ev);
      }

      // Enqueue every channel of the decoded frame atomically on the codec's
      // absolute sample clock. Per-source feed messages allowed the worklet to
      // consume a partial frame and permanently desynchronise late objects.
      const entries = frame.channels.map((samples, ch) => {
        const objectId = channelToObject.get(ch);
        const id = objectId !== undefined ? `obj:${objectId}` : `bed:${ch}`;
        if (objectId === undefined) this.renderer!.addSource(id, { bedLabel: frame.labels[ch] ?? `Bed_${ch}` });
        return { id, samples };
      });
      const sequence = this.nextBatchSequence++;
      const pending = { sequence, frame, samples: frameSamples };
      this.inFlight.set(sequence, pending);
      this.submittedFrames.add(frame);
      outstandingSamples += frameSamples;
      this.renderer.feedBatch(sequence, frame.samplePos, entries);

      if (visualChanged) this.emitVisual();
    }
    this.checkEnded();
  }

  /** 已喂入 worklet 但尚未播出的秒数（真实占着环形缓冲的部分）。 */
  private fedBufferedSeconds(): number {
    if (!this.renderer || this.startupOrigin === null) return 0;
    const cursor = this.playbackStarted ? this.renderer.consumedSamples : this.startupOrigin;
    return Math.max(0, this.acceptedEndSample - cursor) / this.sampleRate;
  }

  private checkEnded(): void {
    if (this.ended && this.pcmQueue.length === 0 && this.fedBufferedSeconds() <= 0.2) {
      this.ended = false;
      if (this.visualTimer) clearInterval(this.visualTimer);
      this.visualTimer = null;
      this.cb.onEnded?.();
    }
  }

  private emitVisual(): void {
    const streamTimeSec = this.positionSeconds();
    const playedSample = Math.floor(streamTimeSec * this.sampleRate);
    while (
      this.pendingVisualEvents.length > 0 &&
      this.pendingVisualEvents[0]!.samplePos <= playedSample
    ) {
      const event = this.pendingVisualEvents.shift()!;
      this.objects.set(event.id, visualObjectFromEvent(event));
    }
    // 即使没有任何对象（纯床层/立体声文件）也要发，时间轴靠它驱动。
    this.cb.onVisualState?.([...this.objects.values()], streamTimeSec);
  }
}
