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
  onTrack?: (info: { codec: string; sampleRate: number; channels: number; container: string }) => void;
  /** Throttled (~per frame batch) object-state snapshot for the 3D view. */
  onVisualState?: (objects: VisualObject[], streamTimeSec: number) => void;
  onError?: (message: string) => void;
  /** Fired when the input ended and the renderer drained. */
  onEnded?: () => void;
}

const TARGET_AHEAD_SECONDS = 2;
const CHUNK_SIZE = 1 << 20; // 1 MiB reads

export class SdaPlayer {
  private worker: Worker;
  private renderer: SpatialRenderer | null = null;
  private cb: PlayerCallbacks;
  private readyResolve!: () => void;
  private ready: Promise<void>;
  private objectChannels = new Map<number, number>(); // object id → PCM channel
  private trackReported = false;
  private knownBedLabels: string[] = [];
  private fedSamples = 0;
  private startCtxTime = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
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
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.renderer = new SpatialRenderer(ctx, { mode, layout });
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
    this.startCtxTime = this.renderer.ctx.currentTime;
    this.pausedAt = null;
    this.pausedTotal = 0;
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
    this.pausedAt = null;
    this.pausedTotal = 0;
    this.objects.clear();
    this.objectChannels.clear();
    this.fedSamples = 0;
  }

  /** Pause: silence the worklet (buffer-preserving) AND suspend the clock.
   *  Either mechanism alone is sufficient; both together cover environments
   *  where AudioContext.suspend() is unreliable. */
  async pause(): Promise<void> {
    if (!this.renderer) return;
    this.renderer.setPaused(true);
    if (this.pausedAt == null) this.pausedAt = this.renderer.ctx.currentTime;
    await this.renderer.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (!this.renderer) return;
    this.renderer.setPaused(false);
    if (this.pausedAt != null) {
      this.pausedTotal += this.renderer.ctx.currentTime - this.pausedAt;
      this.pausedAt = null;
    }
    await this.renderer.ctx.resume();
  }

  setVolume(v: number): void {
    this.renderer?.setVolume(v);
  }

  async dispose(): Promise<void> {
    this.stop();
    this.worker.terminate();
    await this.renderer?.close();
  }

  /** Playhead elapsed on the stream clock, frozen while paused. */
  private elapsed(): number {
    if (!this.renderer) return 0;
    const now = this.pausedAt ?? this.renderer.ctx.currentTime;
    return now - this.startCtxTime - this.pausedTotal;
  }

  /** Current estimated playhead in seconds (stream clock). */
  positionSeconds(): number {
    if (!this.renderer) return 0;
    return Math.max(0, Math.min(this.elapsed(), this.fedSamples / this.sampleRate));
  }

  durationSeconds(): number {
    return this.fedSamples / this.sampleRate;
  }

  // ---- internals ----

  private async pace(): Promise<void> {
    if (!this.renderer) return;
    while (this.aheadSeconds() > TARGET_AHEAD_SECONDS) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private aheadSeconds(): number {
    if (!this.renderer) return 0;
    return this.fedSamples / this.sampleRate - Math.max(0, this.elapsed());
  }

  private onWorkerMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve();
        break;
      case "track":
        this.trackReported = true;
        this.cb.onTrack?.(msg.track as { codec: string; sampleRate: number; channels: number; container: string });
        break;
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

    this.fedSamples += frame.channels[0]?.length ?? 0;

    if (this.ended && this.aheadSeconds() <= 0) {
      this.cb.onEnded?.();
      this.ended = false;
    }
  }

  private emitVisual(): void {
    if (!this.cb.onVisualState || this.objects.size === 0) return;
    this.cb.onVisualState([...this.objects.values()], this.positionSeconds());
  }
}
