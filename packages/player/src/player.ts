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

import { SpatialRenderer, getBinauralIrSet, type BinauralMode, type OutputMode, type VirtualSpeaker } from "@sda/renderer";
import type { DecodedFrameData, ObjectChannelDecl, ObjectEvent } from "@sda/core";

export interface VisualObject {
  id: number;
  pos: [number, number, number]; // ADM cartesian
  hasPos: boolean;
  size: [number, number, number];
  gainDb: number;
}

export interface PlayerCallbacks {
  onTrack?: (info: { codec: string; sampleRate: number; channels: number; container: string; durationSec?: number; title?: string }) => void;
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
  private trackReported = false;
  private knownBedLabels: string[] = [];
  private fedSamples = 0;
  /** 已解码但尚未喂入 worklet 的帧队列（背压：环形缓冲只有 ~5.5s，
   *  直接灌会被静默丢弃，必须按播放头消耗速度泵入）。 */
  private pcmQueue: DecodedFrameData[] = [];
  private queuedSamples = 0;
  /** 容器头部元数据给出的真实总时长（裸流没有，回退到已解码时长）。 */
  private containerDurationSec: number | null = null;
  private sampleRate = 48000;
  private objects = new Map<number, VisualObject>();
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
  /** 是否已按码流采样率校准过 AudioContext（每次播放只校准一次）。 */
  private rateChecked = false;
  private disposed = false;

  constructor(cb: PlayerCallbacks = {}) {
    this.cb = cb;
    this.worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise<void>((res) => (this.readyResolve = res));
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
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
      onConsumedTick: () => this.pumpPcm(),
    });
    await this.renderer.init(workletUrl);
    void this.attachBinauralIrs(this.renderer);
    this.worker.postMessage({ type: "init" });
    await this.ready;
  }

  /** 加载双耳 IR 集（SADIE II KU100）并注入渲染器。失败时优雅降级到
   *  浏览器内置 HRTF（PannerNode），播放不受影响。原始数据跨 AudioContext
   *  缓存，采样率对齐重建时不会重复下载。 */
  private async attachBinauralIrs(r: SpatialRenderer): Promise<void> {
    if (this.initArgs?.mode !== "binaural") return;
    try {
      const set = await getBinauralIrSet(this.initArgs.binauralBaseUrl);
      if (this.disposed || this.renderer !== r) return;
      r.setBinauralData(set);
      r.setBinauralMode(this.binauralMode);
      console.log(`[SDA] player#${this.id} 双耳 IR 已加载（${set.positions.length} 方向 @${set.sampleRate}Hz）`);
    } catch (e) {
      console.warn(`[SDA] player#${this.id} 双耳 IR 资产缺失，回退浏览器内置 HRTF（先跑 node scripts/build-hrtf.mjs）`, e);
    }
  }

  /** 切换杜比近/中/远（播放中实时生效）。 */
  setBinauralMode(mode: BinauralMode): void {
    this.binauralMode = mode;
    this.renderer?.setBinauralMode(mode);
  }

  /** 静音/取消静音一个对象（Omniphony 式 per-object mute 原语；
   *  solo 由 UI 层用"mute 其他全部"组合实现）。对象尚未声明时
   *  只记录状态，声明到达/渲染器重建时自动生效。 */
  setObjectMuted(objectId: number, muted: boolean): void {
    if (muted) this.mutedObjects.add(objectId);
    else this.mutedObjects.delete(objectId);
    const r = this.renderer;
    if (!r) return;
    // 已声明的对象必须命中声源；未命中说明 id 链路断了，告诉用户而不是静默吞掉。
    // （未声明的对象属正常 —— 状态已记录，声明到达时会应用。）
    if (this.objectChannels.has(objectId) && !r.setSourceMuted(`obj:${objectId}`, muted)) {
      this.cb.onError?.(`静音未命中：obj:${objectId} 已声明但渲染器无此声源`);
    } else if (!this.objectChannels.has(objectId)) {
      r.setSourceMuted(`obj:${objectId}`, muted); // 记录用；无源时 renderer 打 warn
    }
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
   *  并发跑 recreateRenderer 会泄漏 AudioContext —— 必须串行）。 */
  private scheduleRecreate(sampleRate: number, layout?: readonly VirtualSpeaker[]): void {
    if (layout && this.initArgs) this.initArgs.layout = layout;
    this.recreateChain = this.recreateChain.then(() => this.recreateRenderer(sampleRate));
  }

  private async recreateRenderer(sampleRate: number): Promise<void> {
    const { mode, workletUrl, layout } = this.initArgs!;
    const old = this.renderer;
    this.renderer = null; // pump/feed 暂停，帧在队列里堆积
    await old?.close();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: "playback", sampleRate });
    } catch {
      // 设备不接受该采样率：退回默认速率（仍会变速，但优于无声）
      ctx = new AudioContext({ latencyHint: "playback" });
    }
    const r = new SpatialRenderer(ctx, { mode, layout, onConsumedTick: () => this.pumpPcm() });
    await r.init(workletUrl);
    if (this.disposed) {
      await r.close();
      return;
    }
    r.setVolume(this.lastVolume);
    this.renderer = r;
    // 恢复暂停意图：重建的 worklet 默认不暂停、新 AudioContext 默认 running，
    // 不恢复的话暂停中重建会让音频自己继续响（UI 仍显示暂停，按钮看似失效）
    if (this.pausedState) {
      r.setPaused(true);
      void r.ctx.suspend().catch(() => {});
    }
    // 采样率对齐重建后：重新注入双耳 IR（原始数据有缓存，不会重复下载）
    void this.attachBinauralIrs(r);
    // 床层/对象源在新 worklet 里重新声明
    this.knownBedLabels = [];
    for (const id of this.objectChannels.keys()) r.addSource(`obj:${id}`);
    // 恢复静音状态（addSource 重置源状态）
    for (const id of this.mutedObjects) r.setSourceMuted(`obj:${id}`, true);
    this.pumpPcm();
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
    this.ended = true;
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

  stop(): void {
    if (this.visualTimer) clearInterval(this.visualTimer);
    this.visualTimer = null;
    this.renderer?.resetBuffers();
    // 若暂停中停止，同时解除 worklet 静音和时钟挂起，避免卡死
    this.pausedState = false;
    this.renderer?.setPaused(false);
    void this.renderer?.ctx.resume();
    this.objects.clear();
    this.objectChannels.clear();
    this.fedSamples = 0;
    this.pcmQueue = [];
    this.queuedSamples = 0;
    this.containerDurationSec = null;
    this.rateChecked = false;
    this.layoutChecked = false;
    this.layoutHadDynamics = false;
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
    return this.containerDurationSec ?? this.fedSamples / this.sampleRate;
  }

  // ---- internals ----

  private async pace(): Promise<void> {
    if (!this.renderer) return;
    while (this.aheadSeconds() > TARGET_AHEAD_SECONDS) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private aheadSeconds(): number {
    // 读取节流看的是"已解码但未播出"总量 = 队列里的 + 环形缓冲里的。
    return this.queuedSamples / this.sampleRate + this.fedBufferedSeconds();
  }

  private onWorkerMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve();
        break;
      case "track": {
        this.trackReported = true;
        const track = msg.track as { codec: string; sampleRate: number; channels: number; container: string; durationSec?: number; title?: string };
        if (track.durationSec && Number.isFinite(track.durationSec)) {
          this.containerDurationSec = track.durationSec;
        }
        this.ensureStreamRate(track.sampleRate);
        this.cb.onTrack?.(track);
        break;
      }
      case "frame":
        this.handleFrame(msg.frame as DecodedFrameData);
        break;
      case "error":
        this.cb.onError?.(String(msg.message));
        break;
    }
  }

  private handleFrame(frame: DecodedFrameData): void {
    if (!this.renderer) return;
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

  /** 把队列里的帧泵入 worklet 环形缓冲，保持喂入量领先播放头 ~TARGET 秒。 */
  private pumpPcm(): void {
    if (!this.renderer) return;
    while (this.pcmQueue.length > 0 && this.fedBufferedSeconds() <= TARGET_AHEAD_SECONDS) {
      const frame = this.pcmQueue.shift()!;
      // 注意：必须先取帧长再 feed —— feed 会转移（detach）ArrayBuffer，
      // 转移后主线程读到的 length 是 0，fedSamples 永远计不上。
      const frameSamples = frame.channels[0]?.length ?? 0;
      this.queuedSamples -= frameSamples;

      // (Re)declare bed sources when labels change.
      if (frame.labels.join() !== this.knownBedLabels.join()) {
        this.knownBedLabels = frame.labels;
        frame.labels.forEach((label, ch) => {
          if (!label.startsWith("Obj_")) {
            this.renderer!.addSource(`bed:${ch}`, { bedLabel: label });
          }
        });
      }

      // Sparse object↔channel declaration.
      const channelToObject = new Map<number, number>();
      for (const decl of frame.objectChannels as ObjectChannelDecl[]) {
        this.objectChannels.set(decl.id, decl.channel);
        this.renderer.addSource(`obj:${decl.id}`);
        // 重新声明会重置源状态 —— 恢复静音
        if (this.mutedObjects.has(decl.id)) this.renderer.setSourceMuted(`obj:${decl.id}`, true);
      }
      for (const [id, ch] of this.objectChannels) channelToObject.set(ch, id);

      // 布局自动检测（仅在 init 传入 layoutResolver 时启用）：首帧按床标签
      // + 是否有动态对象推断布局，不一致则排队重建渲染器，本帧重新排队。
      // 对象声明迟到的码流（对象中流才出现）会再检测一次。
      const resolver = this.initArgs?.layoutResolver;
      const hasDyn = this.objectChannels.size > 0;
      if (resolver && (!this.layoutChecked || (!this.layoutHadDynamics && hasDyn))) {
        this.layoutChecked = true;
        this.layoutHadDynamics = hasDyn;
        const next = resolver(frame.labels, hasDyn);
        const cur = this.initArgs?.layout;
        const same =
          next && cur && next.length === cur.length && next.every((s, i) => s.name === cur[i].name);
        if (next && !same) {
          console.log(
            `[SDA] player#${this.id} 布局自动检测 → ${next.length} 音箱（${hasDyn ? "含动态对象" : "纯床层"}），重建渲染器`,
          );
          this.pcmQueue.unshift(frame);
          this.queuedSamples += frameSamples; // 上面已减过，补回
          this.scheduleRecreate(this.sampleRate, next);
          return;
        }
      }

      // Feed PCM: object channels go to their obj: source, the rest are beds.
      frame.channels.forEach((samples, ch) => {
        const objectId = channelToObject.get(ch);
        this.renderer!.feed(objectId !== undefined ? `obj:${objectId}` : `bed:${ch}`, samples);
      });

      // Object events → renderer gains + visualization state.
      for (const ev of frame.events as ObjectEvent[]) {
        this.renderer.applyEvent(ev, ev.rampDuration || 128);
        this.objects.set(ev.id, {
          id: ev.id,
          pos: ev.pos,
          hasPos: ev.hasPos,
          size: ev.size,
          gainDb: ev.gainDb,
        });
      }

      this.fedSamples += frameSamples;
    }
    this.checkEnded();
  }

  /** 已喂入 worklet 但尚未播出的秒数（真实占着环形缓冲的部分）。 */
  private fedBufferedSeconds(): number {
    if (!this.renderer) return 0;
    return this.fedSamples / this.sampleRate - this.renderer.consumedSeconds();
  }

  private checkEnded(): void {
    if (this.ended && this.pcmQueue.length === 0 && this.fedBufferedSeconds() <= 0.2) {
      this.ended = false;
      this.cb.onEnded?.();
    }
  }

  private emitVisual(): void {
    // 即使没有任何对象（纯床层/立体声文件）也要发，时间轴靠它驱动。
    this.cb.onVisualState?.([...this.objects.values()], this.positionSeconds());
  }
}
