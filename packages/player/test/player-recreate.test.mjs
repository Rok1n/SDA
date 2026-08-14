import assert from "node:assert/strict";
import { SdaPlayer } from "../src/player.ts";

function frame(samplePos, samples) {
  return {
    codec: "test",
    sampleRate: 48_000,
    samplePos,
    channels: [Float32Array.from(samples)],
    labels: ["FrontLeft"],
    rawBedLabels: ["FrontLeft"],
    events: [],
    objectChannels: [],
    programLoudness: null,
    rampDuration: 128,
  };
}

// Constructor tests need only the worker shell; no decoder work is performed.
globalThis.Worker ??= class {
  terminate() {}
};

function player() {
  const p = Object.create(SdaPlayer.prototype);
  Object.assign(p, {
    cb: {},
    rendererGeneration: 4,
    acceptedFrames: [],
    pcmQueue: [],
    queuedSamples: 0,
    acceptedEndSample: 0,
    startupOrigin: null,
    startupAcceptedEnd: 0,
    playbackStarted: false,
    inFlight: new Map(),
    submittedFrames: new Set(),
    batchResults: new Map(),
    sampleRate: 48_000,
    renderer: null,
    recreatePending: 0,
    rateChecked: false,
    initialRendererReady: true,
    initialRendererRate: null,
    requestedOutputLatencySeconds: 0.1,
    pendingOutputLatencySeconds: 0.1,
    sustainedCallbackGapTicks: 0,
    health: {
      requestedOutputLatencySeconds: 0.1,
      nextRecommendedOutputLatencySeconds: 0.1,
      callbackGaps: 0,
      underrunSamples: 0,
      tick: {},
      decodeRealtimeMultiplier: 0,
      fedBufferedSeconds: 0,
      queuedSeconds: 0,
    },
    disposed: false,
  });
  p.pumpPcm = () => {};
  return p;
}

// Construction uses an approved persisted 300ms setting before init creates its
// first AudioContext; unsupported values safely return to the 100ms default.
{
  const approved = new SdaPlayer({}, { initialOutputLatencySeconds: 0.3 });
  assert.equal(approved.requestedOutputLatencySeconds, 0.3);
  assert.equal(approved.pendingOutputLatencySeconds, 0.3);
  assert.equal(approved.health.requestedOutputLatencySeconds, 0.3);
  assert.equal(approved.health.nextRecommendedOutputLatencySeconds, 0.3);

  const invalid = new SdaPlayer({}, { initialOutputLatencySeconds: 0.25 });
  assert.equal(invalid.requestedOutputLatencySeconds, 0.1);
  assert.equal(invalid.pendingOutputLatencySeconds, 0.1);
  assert.equal(invalid.health.nextRecommendedOutputLatencySeconds, 0.1);
}

// Both sample-rate (44.1 -> 48 kHz) and adaptive-latency recreations use this
// path: frames already acknowledged but not yet rendered are replayed exactly
// once, with a partially rendered first frame trimmed to the old cursor.
{
  const p = player();
  const first = frame(0, Array.from({ length: 10 }, (_, i) => i));
  const second = frame(10, Array.from({ length: 10 }, (_, i) => i + 10));
  const queued = frame(20, Array.from({ length: 10 }, (_, i) => i + 20));
  p.acceptedFrames = [first, second];
  p.pcmQueue = [queued];
  p.replayUnconsumedFrames(5);

  assert.deepEqual(p.pcmQueue.map((f) => f.samplePos), [5, 10, 20]);
  assert.deepEqual([...p.pcmQueue[0].channels[0]], [5, 6, 7, 8, 9]);
  assert.equal(p.queuedSamples, 25);
  assert.deepEqual(p.acceptedFrames, []);
  assert.equal(p.startupOrigin, null);
}

// A delayed acknowledgement from the retired worklet must not remove or commit
// a batch belonging to the active renderer generation.
{
  const p = player();
  const pending = frame(0, [0, 1, 2, 3]);
  p.pcmQueue = [pending];
  p.queuedSamples = 4;
  p.inFlight.set(7, { sequence: 7, frame: pending, samples: 4 });
  p.submittedFrames.add(pending);
  p.handleBatchResult(3, { sequence: 7, accepted: true, samples: 4 });

  assert.equal(p.inFlight.size, 1);
  assert.equal(p.pcmQueue.length, 1);
  assert.equal(p.acceptedFrames.length, 0);
}

// Startup must derive its origin from an acknowledged contiguous range, never
// from an unaccepted submitted frame.
{
  const p = player();
  const started = [];
  p.renderer = {
    maxBufferedSeconds: () => 1,
    startAt: (sample) => started.push(sample),
    consumedSamples: 0,
  };
  p.sampleRate = 10;
  const accepted = frame(10, [1, 2, 3, 4, 5]);
  const gap = frame(20, [6, 7, 8, 9, 10]);
  p.pcmQueue = [accepted, gap];
  p.queuedSamples = 10;
  p.batchResults.set(accepted, { sequence: 1, accepted: true, samples: 5 });
  p.batchResults.set(gap, { sequence: 2, accepted: true, samples: 5 });
  p.commitBatchResults();

  assert.deepEqual(started, [10]);
  assert.equal(p.startupOrigin, 10);
  assert.equal(p.startupAcceptedEnd, 15);
}

// Sustained callback gaps only recommend a future-session latency. They must
// never replace the active renderer or disturb its sample clock.
{
  const p = player();
  let recreateCalls = 0;
  let healthEmits = 0;
  const recommendations = [];
  p.cb.onOutputLatencyRecommendation = (seconds) => recommendations.push(seconds);
  p.renderer = { ctx: { sampleRate: 48_000 } };
  p.initArgs = {};
  p.scheduleRecreate = () => { recreateCalls++; };
  p.emitHealth = () => { healthEmits++; };
  for (let i = 0; i < 8; i++) p.observeCallbackGaps(1);

  assert.equal(recreateCalls, 0);
  assert.equal(p.requestedOutputLatencySeconds, 0.1);
  assert.equal(p.pendingOutputLatencySeconds, 0.2);
  assert.equal(p.health.nextRecommendedOutputLatencySeconds, 0.2);
  assert.deepEqual(recommendations, [0.2]);
  assert.equal(healthEmits, 1);
}

// PCM and startAt remain blocked until the stream-rate renderer is known ready.
// This models a default 44.1 kHz context receiving a 48 kHz first track/frame.
{
  const p = player();
  let pumpCalls = 0;
  let recreateRate = 0;
  let starts = 0;
  p.renderer = {
    ctx: { sampleRate: 44_100 },
    maxBufferedSeconds: () => 1,
    startAt: () => { starts++; },
  };
  p.initArgs = {};
  p.initialRendererReady = false;
  p.pumpPcm = () => { pumpCalls++; };
  p.scheduleRecreate = (rate) => { recreateRate = rate; };
  p.ensureStreamRate(48_000);
  p.startupOrigin = 0;
  p.startupAcceptedEnd = 48_000;
  p.startPlaybackIfReady();

  assert.equal(recreateRate, 48_000);
  assert.equal(pumpCalls, 0);
  assert.equal(starts, 0);

  p.renderer.ctx.sampleRate = 48_000;
  p.initialRendererRate = 48_000;
  p.initialRendererReady = Math.abs(p.renderer.ctx.sampleRate - p.initialRendererRate) < 1;
  p.startPlaybackIfReady();
  assert.equal(starts, 1);
}

console.log("player recreate tests: OK");
