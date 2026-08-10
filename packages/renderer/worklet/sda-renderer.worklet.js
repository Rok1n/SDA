/**
 * sda-renderer AudioWorkletProcessor — plain JS, no imports (AudioWorklet
 * modules are loaded standalone via `audioWorklet.addModule()`).
 *
 * Model:
 *   - up to MAX_SOURCES mono sources (bed channels + object channels)
 *   - each source has a PCM ring buffer (fed via port "feed" messages)
 *     and a gain vector over N virtual-speaker buses (set via "gains"
 *     messages, linearly ramped over `ramp` samples)
 *   - process() mixes every source into the buses; the single output has
 *     N channels (one per bus). What happens downstream (multichannel
 *     mapping or HRTF convolution) is decided on the main thread.
 *
 * Underrun: a source with insufficient buffered samples outputs silence.
 */

const MAX_SOURCES = 64;
const RING_SIZE = 1 << 18; // 262144 samples ≈ 5.5 s @48k per source

class SdaRendererProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.busCount = opts.busCount || 12;
    this.paused = false;
    // 已实际输出（消耗）的帧数 —— 播放头的唯一权威来源。
    // 暂停时不推进，主线程的 ctx 时钟漂移/挂起都不影响它。
    this.consumed = 0;
    this.lastTick = 0;
    this.sources = new Map(); // id -> {ring, read, write, gains, target, rampLeft, rampStep, gain}
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    switch (msg.type) {
      case "add": {
        if (this.sources.size >= MAX_SOURCES || this.sources.has(msg.id)) break;
        this.sources.set(msg.id, {
          ring: new Float32Array(RING_SIZE),
          read: 0,
          write: 0,
          gains: new Float32Array(this.busCount),
          target: new Float32Array(this.busCount),
          rampLeft: 0,
          rampStep: new Float32Array(this.busCount),
          gain: 1,
          targetGain: 1,
        });
        break;
      }
      case "remove":
        this.sources.delete(msg.id);
        break;
      case "feed": {
        const src = this.sources.get(msg.id);
        if (!src) break;
        const data = msg.samples; // Float32Array
        const space = RING_SIZE - (src.write - src.read);
        const n = Math.min(data.length, space);
        for (let i = 0; i < n; i++) {
          src.ring[src.write & (RING_SIZE - 1)] = data[i];
          src.write++;
        }
        break;
      }
      case "gains": {
        const src = this.sources.get(msg.id);
        if (!src) break;
        const target = msg.gains; // Float32Array, length busCount
        const ramp = Math.max(1, msg.ramp | 0);
        for (let i = 0; i < this.busCount; i++) {
          src.target[i] = Math.min(target.length > i ? target[i] : 0, 4);
          src.rampStep[i] = (src.target[i] - src.gains[i]) / ramp;
        }
        src.targetGain = msg.gain ?? 1;
        src.rampLeft = ramp;
        break;
      }
      case "reset":
        for (const src of this.sources.values()) {
          src.read = src.write = 0;
        }
        this.paused = false;
        this.consumed = 0;
        this.lastTick = 0;
        break;
      case "pause":
        // 主线程 ctx.suspend() 不可信时的硬暂停：静音且不消耗缓冲，
        // 恢复时从精确位置继续。
        this.paused = !!msg.paused;
        break;
    }
  }

  buffered(id) {
    const src = this.sources.get(id);
    return src ? src.write - src.read : 0;
  }

  process(_inputs, outputs) {
    const buses = outputs[0];
    const blockSize = buses[0] ? buses[0].length : 128;
    for (let b = 0; b < this.busCount && b < buses.length; b++) buses[b].fill(0);

    // 暂停：输出静音但不推进读指针，缓冲原地保留。
    if (this.paused) return true;

    for (const src of this.sources.values()) {
      const available = src.write - src.read;
      const n = Math.min(blockSize, available);
      let gain = src.gain;
      const gainStep = (src.targetGain - gain) / Math.max(1, src.rampLeft);

      for (let i = 0; i < n; i++) {
        const sample = src.ring[src.read & (RING_SIZE - 1)] * gain;
        src.read++;
        if (src.rampLeft > 0) {
          for (let b = 0; b < this.busCount; b++) src.gains[b] += src.rampStep[b];
          gain += gainStep;
          src.rampLeft--;
        }
        for (let b = 0; b < this.busCount && b < buses.length; b++) {
          const g = src.gains[b];
          if (g !== 0) buses[b][i] += sample * g;
        }
      }
      src.gain = gain;
      // starvation: leave read pointer; samples will arrive late → silence gap
    }

    // 每输出一个 block，播放头就前进 blockSize 帧（含欠载静音段）。
    // 约每 1/8 秒向主线程上报一次，供时间轴/缓冲水位使用。
    this.consumed += blockSize;
    const tickEvery = (typeof sampleRate === "number" ? sampleRate : 48000) >> 3;
    if (this.consumed - this.lastTick >= tickEvery) {
      this.lastTick = this.consumed;
      this.port.postMessage({ type: "tick", consumed: this.consumed });
    }
    return true;
  }
}

registerProcessor("sda-renderer", SdaRendererProcessor);
