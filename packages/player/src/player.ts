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

import { SpatialRenderer, type OutputMode, type VirtualSpeaker } from "@sda/renderer";
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

  constructor(cb: PlayerCallbacks = {}) {
    this.cb = cb;
    this.worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise<void>((res) => (this.readyResolve = res));
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
  }

  async init(mode: OutputMode, workletUrl: string | URL, layout?: readonly VirtualSpeaker[]): Promise<void> {
    console.log(`[SDA] player#${this.id} init (active=#${SdaPlayer.active?.id ?? "-"})`);
    if (SdaPlayer.active && SdaPlayer.active !== this) {
      console.warn(`[SDA] player#${this.id} 强制销毁泄漏的 player#${SdaPlayer.active.id}`);
      void SdaPlayer.active.dispose();
    }
    SdaPlayer.active = this;
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.renderer = new SpatialRenderer(ctx, {
      mode,
      layout,
      onConsumedTick: () => this.pumpPcm(),
    });
    await this.renderer.init(workletUrl);
    this.worker.postMessage({ type: "init" });
    await this.ready;
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
    this.renderer?.setPaused(false);
    void this.renderer?.ctx.resume();
    this.objects.clear();
    this.objectChannels.clear();
    this.fedSamples = 0;
    this.pcmQueue = [];
    this.queuedSamples = 0;
    this.containerDurationSec = null;
  }

  /** Pause: silence the worklet (buffer-preserving) AND suspend the clock.
   *  The worklet mute alone is sufficient — its consumed counter freezes,
   *  so the playhead stops with it. suspend() is a best-effort backup. */
  async pause(): Promise<void> {
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
    this.renderer?.setVolume(v);
  }

  async dispose(): Promise<void> {
    console.log(`[SDA] player#${this.id} dispose`);
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
      }
      for (const [id, ch] of this.objectChannels) channelToObject.set(ch, id);

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
