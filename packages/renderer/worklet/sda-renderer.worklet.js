/**
 * sda-renderer AudioWorkletProcessor — plain JS, no imports.
 *
 * PCM and metadata use the decoder's absolute sample clock. A late source may
 * produce silence for samples that have already passed, but it can never play
 * those stale samples later and drift away from the other object channels.
 */

const WORKLET_BUILD = "startup-window-v2";
const MAX_SOURCES = 64;
const RING_SIZE = 1 << 18; // 262144 samples ≈ 5.5 s @48k per source
const RING_MASK = RING_SIZE - 1;

class SdaRendererProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.busCount = opts.busCount || 12;
    this.paused = false;
    this.consumed = 0;
    this.lastTick = 0;
    this.epoch = Number.isSafeInteger(opts.epoch) ? opts.epoch : 0;
    this.timelineStarted = false;
    this.timelineOrigin = null;
    this.sources = new Map();
    this.underrunSamples = 0;
    this.rejectedBatches = 0;
    this.rejectedSources = 0;
    this.port.postMessage({ type: "ready", ringSize: RING_SIZE, maxSources: MAX_SOURCES, build: WORKLET_BUILD });
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  createSource() {
    return {
      ring: new Float32Array(RING_SIZE),
      validStart: Number.POSITIVE_INFINITY,
      validEnd: Number.NEGATIVE_INFINITY,
      gains: new Float32Array(this.busCount),
      target: new Float32Array(this.busCount),
      rampLeft: 0,
      rampStep: new Float32Array(this.busCount),
      gain: 1,
      targetGain: 1,
      gainStep: 0,
      muteGain: 1,
      targetMuteGain: 1,
      muteRampLeft: 0,
      muteStep: 0,
      scheduledGains: [],
      lpA: 1,
      lpY: 0,
      binauralBank: 1,
      availabilityGain: 0,
      availabilityTarget: 0,
      hasReceivedPcm: false,
    };
  }

  /** Advance an active metadata ramp by an exact number of sample intervals. */
  advanceGainRamp(src, samples) {
    const advance = Math.min(Math.max(0, Math.trunc(samples)), src.rampLeft);
    if (advance === 0) return;
    for (let bus = 0; bus < this.busCount; bus++) {
      src.gains[bus] += src.rampStep[bus] * advance;
    }
    src.gain += src.gainStep * advance;
    src.rampLeft -= advance;
    if (src.rampLeft === 0) {
      src.gains.set(src.target);
      src.gain = src.targetGain;
    }
  }

  /** Start an event at eventTime and fast-forward it to currentTime. */
  startGainRampAtTime(src, msg, eventTime, currentTime) {
    const target = msg.gains;
    const ramp = Math.max(1, msg.ramp | 0);
    for (let bus = 0; bus < this.busCount; bus++) {
      src.target[bus] = Math.min(target.length > bus ? target[bus] : 0, 4);
      src.rampStep[bus] = (src.target[bus] - src.gains[bus]) / ramp;
    }
    src.targetGain = msg.gain ?? 1;
    src.gainStep = (src.targetGain - src.gain) / ramp;
    src.lpA = typeof msg.lp === "number" ? Math.min(1, Math.max(0, msg.lp)) : 1;
    src.rampLeft = ramp;
    this.advanceGainRamp(src, currentTime - eventTime);
  }

  /** Replay every overdue event chronologically to currentTime. Each event is
   * advanced only as far as the next event that interrupts it (or now). */
  applyScheduledGainsThrough(src, currentTime) {
    while (
      src.scheduledGains.length > 0 &&
      src.scheduledGains[0].at <= currentTime
    ) {
      const msg = src.scheduledGains.shift();
      const next = src.scheduledGains[0];
      const replayThrough = next && next.at <= currentTime ? next.at : currentTime;
      this.startGainRampAtTime(src, msg, msg.at, replayThrough);
    }
  }

  rejectBatch(sequence, reason) {
    this.rejectedBatches++;
    this.port.postMessage({ type: "batchRejected", sequence, reason });
  }

  feedBatch(start, entries, sequence) {
    if (!Number.isSafeInteger(start) || entries.length === 0) {
      this.rejectBatch(sequence, "invalid");
      return;
    }
    const sources = entries.map((entry) => this.sources.get(entry.id));
    // Port messages are FIFO, so adds normally precede the batch. Never accept
    // only part of a frame if a declaration is missing: partial writes would
    // destroy inter-object phase and time alignment.
    if (sources.some((source) => !source)) {
      this.rejectBatch(sequence, "missing-source");
      return;
    }

    const inputLength = entries.reduce(
      (length, entry) => Math.min(length, entry.samples.length),
      Number.POSITIVE_INFINITY,
    );
    const skipped = this.timelineStarted
      ? Math.min(inputLength, Math.max(0, this.consumed - start))
      : 0;
    const writeStart = start + skipped;
    if (!this.timelineStarted && !Number.isFinite(this.timelineOrigin)) this.timelineOrigin = writeStart;
    const ahead = this.timelineStarted ? Math.max(0, writeStart - this.consumed) : writeStart - this.timelineOrigin;
    const count = inputLength - skipped;
    if (count <= 0 || ahead < 0 || ahead + count > RING_SIZE) {
      this.rejectBatch(sequence, count <= 0 ? "late" : "ring-full");
      return;
    }

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const source = sources[entryIndex];
      const samples = entries[entryIndex].samples;
      // Materialise an explicit silence gap on timeline discontinuities so old
      // ring contents can never be mistaken for valid PCM.
      if (Number.isFinite(source.validEnd) && writeStart > source.validEnd) {
        const gapEnd = Math.min(writeStart, source.validEnd + RING_SIZE);
        for (let position = source.validEnd; position < gapEnd; position++) {
          source.ring[position & RING_MASK] = 0;
        }
      }
      for (let i = 0; i < count; i++) {
        source.ring[(writeStart + i) & RING_MASK] = samples[skipped + i];
      }
      source.validStart = Number.isFinite(source.validStart)
        ? Math.min(source.validStart, writeStart)
        : writeStart;
      source.validEnd = Number.isFinite(source.validEnd)
        ? Math.max(source.validEnd, writeStart + count)
        : writeStart + count;
      source.hasReceivedPcm = true;
    }
    this.port.postMessage({ type: "batchAck", sequence, samples: count });
  }

  onMessage(msg) {
    switch (msg.type) {
      case "add":
        if (this.sources.size >= MAX_SOURCES && !this.sources.has(msg.id)) {
          this.rejectedSources++;
          this.port.postMessage({ type: "sourceRejected", id: msg.id, maxSources: MAX_SOURCES });
        } else if (!this.sources.has(msg.id)) {
          this.sources.set(msg.id, this.createSource());
        }
        break;
      case "remove":
        this.sources.delete(msg.id);
        break;
      case "feed": {
        const src = this.sources.get(msg.id);
        if (!src) break;
        const start = Number.isFinite(src.validEnd) ? src.validEnd : this.consumed;
        this.feedBatch(start, [{ id: msg.id, samples: msg.samples }], -1);
        break;
      }
      case "feedBatch":
        this.feedBatch(msg.start, msg.entries || [], msg.sequence);
        break;
      case "gains": {
        const src = this.sources.get(msg.id);
        if (src) {
          this.startGainRampAtTime(src, msg, this.consumed, this.consumed);
        }
        break;
      }
      case "scheduleGains": {
        const src = this.sources.get(msg.id);
        if (!src || !Number.isSafeInteger(msg.at)) break;
        src.scheduledGains.push(msg);
        src.scheduledGains.sort((left, right) => left.at - right.at);
        break;
      }
      case "mute": {
        const src = this.sources.get(msg.id);
        if (!src) break;
        const ramp = Math.max(1, msg.ramp | 0);
        src.targetMuteGain = msg.muted ? 0 : 1;
        src.muteStep = (src.targetMuteGain - src.muteGain) / ramp;
        src.muteRampLeft = ramp;
        break;
      }
      case "binauralMode": {
        const src = this.sources.get(msg.id);
        if (src) src.binauralBank = Math.max(0, Math.min(3, msg.bank | 0));
        break;
      }
      case "start":
        if (!this.timelineStarted && Number.isSafeInteger(msg.origin)) {
          this.consumed = msg.origin;
          this.lastTick = msg.origin;
          this.timelineOrigin = msg.origin;
          this.timelineStarted = true;
        }
        break;
      case "reset":
        for (const src of this.sources.values()) {
          src.validStart = Number.POSITIVE_INFINITY;
          src.validEnd = Number.NEGATIVE_INFINITY;
          src.scheduledGains.length = 0;
          src.lpY = 0;
          src.availabilityGain = 0;
          src.availabilityTarget = 0;
          src.hasReceivedPcm = false;
        }
        this.paused = false;
        this.consumed = 0;
        this.lastTick = 0;
        this.epoch = Number.isSafeInteger(msg.epoch) ? msg.epoch : this.epoch + 1;
        this.timelineStarted = false;
        this.timelineOrigin = null;
        this.underrunSamples = 0;
        this.rejectedBatches = 0;
        this.rejectedSources = 0;
        this.port.postMessage({ type: "resetAck", epoch: this.epoch });
        break;
      case "pause":
        this.paused = !!msg.paused;
        break;
    }
  }

  buffered(id) {
    const src = this.sources.get(id);
    return src && Number.isFinite(src.validEnd)
      ? Math.max(0, src.validEnd - this.consumed)
      : 0;
  }

  process(_inputs, outputs) {
    const busesByBank = outputs;
    const primaryBuses = busesByBank[0] || [];
    const blockSize = primaryBuses[0] ? primaryBuses[0].length : 128;
    for (const buses of busesByBank) {
      for (let bus = 0; bus < this.busCount && bus < buses.length; bus++) buses[bus].fill(0);
    }
    if (this.paused || !this.timelineStarted) return true;

    for (const src of this.sources.values()) {
      const buses = busesByBank[src.binauralBank] || primaryBuses;
      let gain = src.gain;
      let muteGain = src.muteGain;
      let lpY = src.lpY;

      for (let i = 0; i < blockSize; i++) {
        const samplePosition = this.consumed + i;
        // Commit this block's local scalar before an event replaces the ramp.
        // Otherwise an event in the middle of a render quantum can jump back to
        // src.gain, which still holds the value from the block boundary.
        src.gain = gain;
        this.applyScheduledGainsThrough(src, samplePosition);
        gain = src.gain;

        let sample = 0;
        const available = samplePosition >= src.validStart && samplePosition < src.validEnd;
        src.availabilityTarget = available ? 1 : 0;
        if (available) {
          sample = src.ring[samplePosition & RING_MASK];
        } else if (src.hasReceivedPcm && samplePosition >= src.validStart) {
          this.underrunSamples++;
        }
        // A 32-sample envelope avoids an instantaneous non-zero ↔ zero step when
        // decoder/main-thread delivery briefly misses a render quantum.
        src.availabilityGain += (src.availabilityTarget - src.availabilityGain) / 32;
        sample *= src.availabilityGain;
        if (src.lpA < 0.999) {
          lpY += src.lpA * (sample - lpY);
          sample = lpY;
        }
        sample *= gain * muteGain;

        for (let bus = 0; bus < this.busCount && bus < buses.length; bus++) {
          const busGain = src.gains[bus];
          if (busGain !== 0) buses[bus][i] += sample * busGain;
        }

        if (src.rampLeft > 0) {
          this.advanceGainRamp(src, 1);
          gain = src.gain;
        }
        if (src.muteRampLeft > 0) {
          muteGain += src.muteStep;
          src.muteRampLeft--;
          if (src.muteRampLeft === 0) muteGain = src.targetMuteGain;
        }
      }
      src.gain = gain;
      src.muteGain = muteGain;
      src.lpY = lpY;
    }

    this.consumed += blockSize;
    const tickEvery = (typeof sampleRate === "number" ? sampleRate : 48000) >> 3;
    if (this.consumed - this.lastTick >= tickEvery) {
      this.lastTick = this.consumed;
      this.port.postMessage({
        type: "tick",
        consumed: this.consumed,
        epoch: this.epoch,
        underrunSamples: this.underrunSamples,
        rejectedBatches: this.rejectedBatches,
        rejectedSources: this.rejectedSources,
      });
      this.underrunSamples = 0;
      this.rejectedBatches = 0;
      this.rejectedSources = 0;
    }
    return true;
  }
}

/** Final emergency sample-peak guard. It has no lookahead, oversampling, or
 * release envelope: normal samples pass bit-for-bit and each channel clamps
 * independently only at the configured ceiling. */
class SdaFinalPeakGuardProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ceilingDb = options?.processorOptions?.ceilingDb ?? -0.1;
    this.ceiling = Math.pow(10, ceilingDb / 20);
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    for (let channel = 0; channel < output.length; channel++) {
      const source = input[channel] || input[0];
      const target = output[channel];
      if (!source) {
        target.fill(0);
        continue;
      }
      for (let i = 0; i < target.length; i++) {
        target[i] = Math.max(-this.ceiling, Math.min(this.ceiling, source[i]));
      }
    }
    return true;
  }
}

registerProcessor("sda-renderer", SdaRendererProcessor);
registerProcessor("sda-final-peak-guard", SdaFinalPeakGuardProcessor);
