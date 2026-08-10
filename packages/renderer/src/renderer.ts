/**
 * Main-thread spatial renderer.
 *
 * Graph:
 *   AudioWorkletNode(sda-renderer, N-bus output)
 *     ├── "multichannel": → ctx.destination (N discrete channels)
 *     ├── "binaural":     → ChannelSplitter(N)
 *     │                     → per bus: ConvolverNode(stereo IR)   [IRs loaded]
 *     │                       or PannerNode(mono, HRTF, fixed pos) [fallback]
 *     │                     → ChannelMerger(2) → ctx.destination
 *     └── "stereo":       → downmix gain matrix → merger(2) → destination
 *
 * The binaural path follows the industry-standard virtual-loudspeaker
 * approach (Dolby/EBU BEAR): objects are VBAP-panned onto a fixed virtual
 * speaker ring, then each virtual speaker is binauralised. Convolution
 * count is fixed (bus count × 2 ears), decoupled from object count.
 */

import { admToSpherical, sphericalToWebAudio, type Spherical } from "./coords.js";
import { LAYOUT_7_1_4, positionForLabel, isLfeLabel, type VirtualSpeaker } from "./layouts.js";
import { VbapSolver } from "./vbap.js";
import type { ObjectEvent } from "@sda/core";

export type OutputMode = "multichannel" | "binaural" | "stereo";

export interface RendererOptions {
  mode?: OutputMode;
  layout?: readonly VirtualSpeaker[];
  /** Pre-measured binaural IRs per bus (stereo, e.g. MIT KEMAR derived).
   *  When absent, binaural mode falls back to PannerNode HRTF. */
  binauralIrs?: Map<number, AudioBuffer>;
  /** worklet 每消耗约 1/8 秒回调一次 —— 播放器用它泵入更多 PCM（背压）。 */
  onConsumedTick?: () => void;
}

/** Scalar spread derived from ADM object size (w, d, h in [0,1]). */
function sizeToSpread(size: [number, number, number]): number {
  return Math.min(1, (size[0] + size[1] + size[2]) / 3);
}

/** Simple distance rolloff: inverse model, reference distance = 1. */
function distanceGain(distance: number): number {
  return 1 / Math.max(1, distance);
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
  private sources = new Map<string, SourceState>();
  private irs?: Map<number, AudioBuffer>;
  private onConsumedTick?: () => void;
  /** Frames actually rendered by the worklet (authoritative playhead). */
  consumedSamples = 0;

  constructor(ctx: AudioContext, options: RendererOptions = {}) {
    this.ctx = ctx;
    this.mode = options.mode ?? "binaural";
    this.layout = options.layout ?? LAYOUT_7_1_4;
    this.vbap = new VbapSolver(this.layout);
    if (options.binauralIrs) this.irs = options.binauralIrs;
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

  private teardownPostNodes(): void {
    for (const n of this.postNodes) n.disconnect();
    this.postNodes = [];
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

    for (let bus = 0; bus < n; bus++) {
      const spk = this.layout[bus]!;
      if (this.mode === "binaural") {
        const ir = this.irs?.get(bus);
        if (ir) {
          const conv = this.ctx.createConvolver();
          conv.buffer = ir;
          conv.normalize = false;
          splitter.connect(conv, bus);
          conv.connect(merger, 0, 0);
          conv.connect(merger, 0, 1);
          this.postNodes.push(conv);
        } else {
          // Fallback: browser built-in HRTF at the virtual speaker position.
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
    let scalar = Math.pow(10, state.gainDb / 20) * distanceGain(state.position.distance);
    if (state.isLfe) {
      // LFE bypasses spatial panning: straight to the LFE bus.
      gains.fill(0);
      const lfeBus = this.layout.findIndex((s) => s.isLfe);
      if (lfeBus >= 0) gains[lfeBus] = 1;
      scalar = Math.pow(10, state.gainDb / 20);
    }
    this.node?.port.postMessage({
      type: "gains",
      id: state.id,
      gains,
      gain: scalar,
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
