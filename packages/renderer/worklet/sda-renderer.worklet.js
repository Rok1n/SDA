/**
 * sda-renderer AudioWorkletProcessor — plain JS, no imports.
 *
 * PCM and metadata use the decoder's absolute sample clock. A late source may
 * produce silence for samples that have already passed, but it can never play
 * those stale samples later and drift away from the other object channels.
 */

const WORKLET_BUILD = "object-batch-v1";
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
    // 输出侧回调抖动测量：process() 两次调用的墙钟间隔应约等于一个
    // render quantum（128/48000≈2.67ms）。焦点切换/后台节流导致实时线程
    // 被延迟调度时这里会出现间隙——即便 PCM 环形缓冲充足也会听见卡顿。
    this.lastProcessAt = null;
    this.callbackGaps = 0;
    this.callbackGapMaxMs = 0;
    this.port.postMessage({ type: "ready", ringSize: RING_SIZE, maxSources: MAX_SOURCES, build: WORKLET_BUILD });
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  createSource() {
    return {
      ring: new Float32Array(RING_SIZE),
      valid: new Uint8Array(RING_SIZE),
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
      scheduledGainCursor: 0,
      lpA: 1,
      lpY: 0,
      binauralBank: 1,
      availabilityFrom: 0,
      availabilityRampLeft: 0,
      availabilityLastOutput: 0,
      availabilityWasValid: false,
      hasReceivedPcm: false,
      lifecycleEvents: [],
      lifecycleEventOrder: 0,
      active: true,
      inactiveSince: null,
      inactiveToken: null,
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
    const events = src.scheduledGains;
    let cursor = src.scheduledGainCursor;
    while (cursor < events.length && events[cursor].at <= currentTime) {
      const msg = events[cursor++];
      const next = events[cursor];
      const replayThrough = next && next.at <= currentTime ? next.at : currentTime;
      this.startGainRampAtTime(src, msg, msg.at, replayThrough);
    }
    src.scheduledGainCursor = cursor;
    if (cursor >= 256 && cursor * 2 >= events.length) {
      events.splice(0, cursor);
      src.scheduledGainCursor = 0;
    }
  }

  enqueueScheduledGain(src, msg) {
    const events = src.scheduledGains;
    const cursor = src.scheduledGainCursor;
    const last = events[events.length - 1];
    if (!last || last.at <= msg.at) {
      events.push(msg);
      return;
    }
    let low = cursor;
    let high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (events[middle].at <= msg.at) low = middle + 1;
      else high = middle;
    }
    events.splice(low, 0, msg);
  }

  scheduleLifecycle(src, at, active, token = null) {
    if (!Number.isSafeInteger(at)) return;
    src.lifecycleEvents.push({ at, active, token, order: src.lifecycleEventOrder++ });
    src.lifecycleEvents.sort((left, right) => left.at - right.at || left.order - right.order);
  }

  applyLifecycleThrough(src, currentTime) {
    while (src.lifecycleEvents.length > 0 && src.lifecycleEvents[0].at <= currentTime) {
      const event = src.lifecycleEvents.shift();
      src.active = event.active;
      src.inactiveSince = event.active ? null : event.at;
      src.inactiveToken = event.active ? null : event.token;
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
          const slot = position & RING_MASK;
          source.ring[slot] = 0;
          source.valid[slot] = 0;
        }
      }
      for (let i = 0; i < count; i++) {
        const slot = (writeStart + i) & RING_MASK;
        source.ring[slot] = samples[skipped + i];
        source.valid[slot] = 1;
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
      case "removeAt": {
        const src = this.sources.get(msg.id);
        if (src) this.scheduleLifecycle(src, msg.at, false, msg.token);
        break;
      }
      case "resumeAt": {
        const src = this.sources.get(msg.id);
        if (src) this.scheduleLifecycle(src, msg.at, true);
        break;
      }
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
        this.enqueueScheduledGain(src, msg);
        break;
      }
      case "scheduleGainsBatch":
        for (const entry of msg.entries || []) {
          const src = this.sources.get(entry.id);
          if (src && Number.isSafeInteger(entry.at)) this.enqueueScheduledGain(src, entry);
        }
        break;
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
          src.valid.fill(0);
          src.scheduledGains.length = 0;
          src.scheduledGainCursor = 0;
          src.lpY = 0;
          src.availabilityFrom = 0;
          src.availabilityRampLeft = 0;
          src.availabilityLastOutput = 0;
          src.availabilityWasValid = false;
          src.hasReceivedPcm = false;
          src.lifecycleEvents.length = 0;
          src.lifecycleEventOrder = 0;
          src.active = true;
          src.inactiveSince = null;
          src.inactiveToken = null;
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
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    if (this.lastProcessAt !== null && now > 0 && this.timelineStarted && !this.paused) {
      const gapMs = now - this.lastProcessAt;
      // 正常间隔约 2.67ms；>12ms 视为一次输出侧调度间隙（约 4.5 个 quantum）
      if (gapMs > 12) {
        this.callbackGaps++;
        if (gapMs > this.callbackGapMaxMs) this.callbackGapMaxMs = gapMs;
      }
    }
    this.lastProcessAt = now;
    const busesByBank = outputs;
    const primaryBuses = busesByBank[0] || [];
    const blockSize = primaryBuses[0] ? primaryBuses[0].length : 128;
    for (const buses of busesByBank) {
      for (let bus = 0; bus < this.busCount && bus < buses.length; bus++) buses[bus].fill(0);
    }
    if (this.paused || !this.timelineStarted) return true;

    for (const [sourceId, src] of this.sources) {
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
        const slot = samplePosition & RING_MASK;
        this.applyLifecycleThrough(src, samplePosition);
        const retired = !src.active;
        const available = src.active && samplePosition >= src.validStart && samplePosition < src.validEnd && src.valid[slot] === 1;
        if (available !== src.availabilityWasValid) {
          src.availabilityWasValid = available;
          src.availabilityFrom = src.availabilityLastOutput;
          src.availabilityRampLeft = 32;
        }
        if (!retired && !available && src.hasReceivedPcm && samplePosition >= src.validStart) this.underrunSamples++;
        const target = available ? src.ring[slot] : 0;
        if (src.availabilityRampLeft > 0) {
          const progress = (33 - src.availabilityRampLeft) / 32;
          sample = src.availabilityFrom + (target - src.availabilityFrom) * progress;
          src.availabilityRampLeft--;
        } else {
          sample = target;
        }
        src.availabilityLastOutput = sample;
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
      const blockEnd = this.consumed + blockSize;
      const hasFutureResume = src.lifecycleEvents.some((event) => event.active);
      if (!src.active && !hasFutureResume && src.inactiveSince !== null && blockEnd >= src.inactiveSince + 32) {
        this.sources.delete(sourceId);
        this.port.postMessage({ type: "sourceRetired", id: sourceId, token: src.inactiveToken });
      }
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
        callbackGaps: this.callbackGaps,
        callbackGapMaxMs: Math.round(this.callbackGapMaxMs * 10) / 10,
      });
      this.underrunSamples = 0;
      this.rejectedBatches = 0;
      this.rejectedSources = 0;
      this.callbackGaps = 0;
      this.callbackGapMaxMs = 0;
    }
    return true;
  }
}

/** Stereo-linked lookahead limiter. Both ears share one gain envelope so peak
 * control cannot shift the binaural image. */
class SdaFinalPeakGuardProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ceilingDb = options?.processorOptions?.ceilingDb ?? -1;
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.lookahead = Math.max(1, Math.round((typeof sampleRate === "number" ? sampleRate : 48000) * 0.005));
    this.releaseCoeff = Math.exp(-1 / ((typeof sampleRate === "number" ? sampleRate : 48000) * 0.1));
    this.buffers = [new Float32Array(this.lookahead), new Float32Array(this.lookahead)];
    this.write = 0;
    this.gain = 1;
    this.attackTarget = 1;
    this.attackStep = 0;
    this.hold = 0;
    this.timelineStarted = false;
    this.paused = false;
    this.consumed = 0;
    this.programEnabled = false;
    this.programMetadataGain = 1;
    this.programGain = 1;
    this.programTargetGain = 1;
    this.programGainStep = 0;
    this.programRampLeft = 0;
    this.scheduledProgramGains = [];
    this.programEventOrder = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  setProgramTarget(target, ramp) {
    this.programTargetGain = this.programEnabled ? target : 1;
    if (!this.timelineStarted) {
      this.programGain = this.programTargetGain;
      this.programGainStep = 0;
      this.programRampLeft = 0;
      return;
    }
    this.programRampLeft = Math.max(1, ramp | 0);
    this.programGainStep = (this.programTargetGain - this.programGain) / this.programRampLeft;
  }

  normalizeProgramGain(value) {
    const gain = Number(value);
    return Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 1;
  }

  onMessage(msg) {
    const ramp = Math.max(1, Math.round((typeof sampleRate === "number" ? sampleRate : 48000) * 0.05));
    switch (msg.type) {
      case "programGain":
        this.programMetadataGain = this.normalizeProgramGain(msg.gain);
        this.setProgramTarget(this.programMetadataGain, ramp);
        break;
      case "scheduleProgramGain":
        if (!Number.isSafeInteger(msg.at)) break;
        this.scheduledProgramGains.push({
          at: msg.at,
          gain: this.normalizeProgramGain(msg.gain),
          order: this.programEventOrder++,
        });
        this.scheduledProgramGains.sort((left, right) => left.at - right.at || left.order - right.order);
        break;
      case "programEnabled":
        this.programEnabled = !!msg.enabled;
        this.setProgramTarget(this.programMetadataGain, ramp);
        break;
      case "start":
        if (!this.timelineStarted && Number.isSafeInteger(msg.origin)) {
          this.consumed = msg.origin;
          this.applyProgramEventsThrough(msg.origin);
          this.timelineStarted = true;
        }
        break;
      case "reset":
        this.timelineStarted = false;
        this.paused = false;
        this.consumed = 0;
        for (const buffer of this.buffers) buffer.fill(0);
        this.write = 0;
        this.gain = 1;
        this.attackTarget = 1;
        this.attackStep = 0;
        this.hold = 0;
        this.programMetadataGain = 1;
        this.programGain = 1;
        this.programTargetGain = 1;
        this.programGainStep = 0;
        this.programRampLeft = 0;
        this.scheduledProgramGains.length = 0;
        this.programEventOrder = 0;
        break;
      case "pause":
        this.paused = !!msg.paused;
        break;
    }
  }

  applyProgramEventsThrough(samplePosition) {
    while (this.scheduledProgramGains.length > 0 && this.scheduledProgramGains[0].at <= samplePosition) {
      const event = this.scheduledProgramGains.shift();
      this.programMetadataGain = event.gain;
      const ramp = Math.max(1, Math.round((typeof sampleRate === "number" ? sampleRate : 48000) * 0.05));
      this.setProgramTarget(event.gain, ramp);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const blockSize = output[0]?.length ?? 128;
    if (this.paused) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    for (let i = 0; i < blockSize; i++) {
      if (this.timelineStarted) this.applyProgramEventsThrough(this.consumed + i);
      let peak = 0;
      const delayedLeft = this.buffers[0][this.write];
      const delayedRight = this.buffers[1][this.write];
      for (let channel = 0; channel < 2; channel++) {
        const source = input[channel] || input[0];
        const raw = Number.isFinite(source?.[i]) ? source[i] : 0;
        const sample = raw * this.programGain;
        this.buffers[channel][this.write] = sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const target = peak > this.ceiling ? this.ceiling / peak : 1;
      if (target < this.attackTarget) {
        const nextStep = (target - this.gain) / this.lookahead;
        this.attackStep = this.gain > this.attackTarget
          ? Math.min(this.attackStep, nextStep)
          : nextStep;
        this.attackTarget = target;
      }
      if (target < 1) this.hold = this.lookahead;
      if (this.gain > this.attackTarget) {
        this.gain = Math.max(this.attackTarget, this.gain + this.attackStep);
        if (this.gain === this.attackTarget) this.attackStep = 0;
      } else if (this.hold > 0) {
        this.hold--;
      } else {
        this.gain = 1 - (1 - this.gain) * this.releaseCoeff;
        this.attackTarget = this.gain;
      }
      for (let channel = 0; channel < output.length; channel++) {
        const delayed = channel === 0 ? delayedLeft : delayedRight;
        output[channel][i] = Math.max(-1, Math.min(1, delayed * this.gain));
      }
      if (this.programRampLeft > 0) {
        this.programGain += this.programGainStep;
        this.programRampLeft--;
        if (this.programRampLeft === 0) this.programGain = this.programTargetGain;
      }
      this.write = (this.write + 1) % this.lookahead;
    }
    if (this.timelineStarted) this.consumed += blockSize;
    return true;
  }
}

registerProcessor("sda-renderer", SdaRendererProcessor);
registerProcessor("sda-final-peak-guard", SdaFinalPeakGuardProcessor);
