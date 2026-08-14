// 对象移动 × limiter 增益衰减关联分析
// 问题：+6dB BINAURAL_MAKEUP_GAIN 后，对象移动时是否驱动 linked peak guard
// 产生频繁增益下探（可闻"卡顿"/泵音）？
// 方法：真实解码 KiLLKiSS → VBAP 总线渲染 → KU100 IR 卷积 → 精确复刻
// sda-final-peak-guard 算法，按 100ms 分箱统计 GR，并与同箱对象事件数/位移关联。
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const MP4Box = require("../node_modules/.pnpm/mp4box@0.5.4/node_modules/mp4box/dist/mp4box.all.js");
const core = await import(pathToFileURL(path.resolve("packages/core/pkg-node/sda_core.cjs")).href);
const renderer = require("./renderer.bundle.cjs");

const sourcePath = process.argv[2] ?? "C:/Users/legendshop/Downloads/01. KiLLKiSS.m4a";
const startSample = 30 * 48000;
const endSample = 120 * 48000;
const preRoll = 8192;
const captureStart = startSample - preRoll;
const captureEnd = endSample;
const captureLength = captureEnd - captureStart;
const objectIds = Array.from({ length: 15 }, (_, index) => 10 + index);
const pcm = new Map(objectIds.map((id) => [id, new Float32Array(captureLength)]));
const events = new Map(objectIds.map((id) => [id, []]));

function extractAccessUnits(filePath) {
  const bytes = readFileSync(filePath);
  const file = MP4Box.createFile();
  const accessUnits = [];
  file.onReady = (info) => {
    const track = info.audioTracks.find((candidate) => candidate.codec === "ec-3");
    if (!track) throw new Error("M4A没有ec-3音轨");
    file.setExtractionOptions(track.id, null, { nbSamples: 1000 });
    file.start();
  };
  file.onSamples = (_id, _user, samples) => accessUnits.push(...samples.map((sample) => sample.data));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();
  return accessUnits;
}

const decoder = new core.SdaDecoder("eac3");
for (const accessUnit of extractAccessUnits(sourcePath)) {
  decoder.push(accessUnit);
  for (let frame = decoder.nextFrame(); frame; frame = decoder.nextFrame()) {
    const frameStart = frame.samplePos;
    const frameLength = frame.samplesPerChannel;
    const frameEnd = frameStart + frameLength;
    if (frameEnd >= captureStart - 1536 && frameStart < captureEnd) {
      const declarations = JSON.parse(frame.objectChannelsJson);
      const channelById = new Map(declarations.map((entry) => [entry.id, entry.channel]));
      if (channelById.size === 0) {
        for (let channel = 0; channel < frame.labels.length; channel++) {
          const match = /^Obj_(\d+)$/.exec(frame.labels[channel]);
          if (match) channelById.set(Number(match[1]), channel);
        }
      }
      for (const [id, channel] of channelById) {
        const source = frame.channel(channel);
        const target = pcm.get(id);
        if (!source || !target) continue;
        const first = Math.max(frameStart, captureStart);
        const last = Math.min(frameEnd, captureEnd);
        if (last > first) target.set(source.subarray(first - frameStart, last - frameStart), first - captureStart);
      }
      for (const event of JSON.parse(frame.eventsJson)) {
        if (events.has(event.id) && event.samplePos >= captureStart - 3072 && event.samplePos < captureEnd) {
          events.get(event.id).push(event);
        }
      }
    }
    frame.free();
  }
  if (events.get(10).at(-1)?.samplePos >= captureEnd - 1536) break;
}
const decodeErrors = decoder.drainErrors();
if (decodeErrors.length) throw new Error(`解码错误: ${decodeErrors.slice(0, 3).join("; ")}`);

// ---- 事件统计：每个对象的事件数、位置位移、增益变化 ----
const eventStats = [];
for (const id of objectIds) {
  const updates = events.get(id).sort((a, b) => a.samplePos - b.samplePos);
  let moves = 0;
  let totalDelta = 0;
  let gainChanges = 0;
  for (let i = 1; i < updates.length; i++) {
    const a = updates[i - 1];
    const b = updates[i];
    if (a.hasPos && b.hasPos) {
      const delta = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
      if (delta > 1e-4) { moves++; totalDelta += delta; }
    }
    if (a.gainDb !== b.gainDb) gainChanges++;
  }
  eventStats.push({ id, events: updates.length, moves, totalDelta: +totalDelta.toFixed(3), gainChanges });
}
console.log("=== 对象事件统计（90s 窗口）===");
console.table(eventStats);
const totalEvents = eventStats.reduce((s, e) => s + e.events, 0);
const totalMoves = eventStats.reduce((s, e) => s + e.moves, 0);
console.log(`总事件 ${totalEvents} (${(totalEvents / 90).toFixed(1)}/s), 总位移事件 ${totalMoves}`);

// ---- VBAP 总线渲染（与 killkiss-offline-diagnostic 相同）----
function eventTarget(event, layout, solver) {
  const position = renderer.admToSpherical(event.pos);
  const spread = Math.min(1, (event.size[0] + event.size[1] + event.size[2]) / 3);
  const gains = solver.pan(position, spread);
  const distanceGain = position.distance > 1 ? 1 / position.distance : 1;
  const metadataGain = event.gainDb <= -128 ? 0 : 10 ** (event.gainDb / 20);
  const scalar = distanceGain * metadataGain;
  return Float64Array.from(gains, (gain) => gain * scalar);
}

function renderBuses(layoutId) {
  const layout = renderer.LAYOUTS[layoutId];
  const solver = new renderer.VbapSolver(layout);
  const buses = layout.map(() => new Float64Array(captureLength));
  for (const id of objectIds) {
    const source = pcm.get(id);
    const updates = events.get(id).sort((a, b) => a.samplePos - b.samplePos);
    if (updates.length < 2) continue;
    for (let eventIndex = 1; eventIndex < updates.length; eventIndex++) {
      const previous = updates[eventIndex - 1];
      const current = updates[eventIndex];
      const from = Math.max(previous.samplePos, captureStart);
      const to = Math.min(current.samplePos, captureEnd);
      if (to <= from) continue;
      const startGains = eventTarget(previous, layout, solver);
      const endGains = eventTarget(current, layout, solver);
      const duration = Math.max(1, current.samplePos - previous.samplePos);
      for (let bus = 0; bus < layout.length; bus++) {
        if (layout[bus].isLfe) continue;
        const startGain = startGains[bus];
        const slope = (endGains[bus] - startGain) / duration;
        if (startGain === 0 && slope === 0) continue;
        const output = buses[bus];
        for (let sample = from; sample < to; sample++) {
          output[sample - captureStart] += source[sample - captureStart]
            * (startGain + slope * (sample - previous.samplePos));
        }
      }
    }
  }
  return { layout, buses };
}

// ---- FFT 卷积 ----
function fft(real, imaginary, inverse = false) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset;
        const odd = start + offset + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + stepImaginary * twiddleReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index++) {
      real[index] /= size;
      imaginary[index] /= size;
    }
  }
}

function peakIndex(values, limit = values.length) {
  let bestIndex = 0;
  let bestValue = 0;
  for (let index = 0; index < Math.min(values.length, limit); index++) {
    const value = Math.abs(values[index]);
    if (value > bestValue) { bestValue = value; bestIndex = index; }
  }
  return bestIndex;
}

function loadIr(directory, manifest, speaker, wetWeight) {
  const legacyMirror = manifest.calibrationVersion === undefined && speaker.name === "WideRight";
  const azimuth = legacyMirror ? -speaker.azimuth : speaker.azimuth;
  const entry = manifest.positions.find((p) => p.azimuth === azimuth && p.elevation === speaker.elevation);
  if (!entry) throw new Error(`缺IR ${speaker.azimuth}/${speaker.elevation}`);
  const read = (fileName) => {
    const bytes = readFileSync(path.join(directory, fileName));
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  };
  const dry = read(entry.dry);
  const wet = read(entry.wet);
  const dryLength = dry.length >> 1;
  const wetLength = wet.length >> 1;
  const legacy = manifest.calibrationVersion === undefined;
  const shift = legacy ? peakIndex(wet.subarray(0, wetLength), 960) - peakIndex(dry.subarray(0, dryLength)) : 0;
  const output = [0, 1].map((ear) => {
    const samples = new Float64Array(wetLength);
    const dryOffset = ear * dryLength;
    const wetOffset = ear * wetLength;
    for (let sample = 0; sample < wetLength; sample++) samples[sample] = wetWeight * wet[wetOffset + sample];
    for (let sample = 0; sample < dryLength; sample++) {
      const target = sample + shift;
      if (target >= 0 && target < wetLength) samples[target] += (1 - wetWeight) * dry[dryOffset + sample];
    }
    return samples;
  });
  if (legacy && Math.abs(azimuth) < 1e-6) {
    const energy = output.map((samples) => samples.reduce((sum, value) => sum + value ** 2, 0));
    const target = (energy[0] + energy[1]) / 2;
    for (let ear = 0; ear < 2; ear++) {
      const scale = Math.sqrt(target / energy[ear]);
      for (let sample = 0; sample < wetLength; sample++) output[ear][sample] *= scale;
    }
  }
  if (legacy) {
    let energy = 0;
    for (const samples of output) for (const value of samples) energy += value ** 2;
    const scale = 1 / Math.sqrt(energy || 1);
    for (const samples of output) for (let sample = 0; sample < wetLength; sample++) samples[sample] *= scale;
  }
  return legacyMirror ? [output[1], output[0]] : output;
}

function convolveBus(signal, impulses, outputs) {
  const fftSize = 16384;
  const blockSize = fftSize - impulses[0].length + 1;
  const spectra = impulses.map((impulse) => {
    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    real.set(impulse);
    fft(real, imaginary);
    return { real, imaginary };
  });
  for (let offset = 0; offset < signal.length; offset += blockSize) {
    const inputReal = new Float64Array(fftSize);
    const inputImaginary = new Float64Array(fftSize);
    inputReal.set(signal.subarray(offset, Math.min(signal.length, offset + blockSize)));
    fft(inputReal, inputImaginary);
    for (let ear = 0; ear < 2; ear++) {
      const real = new Float64Array(fftSize);
      const imaginary = new Float64Array(fftSize);
      const spectrum = spectra[ear];
      for (let bin = 0; bin < fftSize; bin++) {
        real[bin] = inputReal[bin] * spectrum.real[bin] - inputImaginary[bin] * spectrum.imaginary[bin];
        imaginary[bin] = inputReal[bin] * spectrum.imaginary[bin] + inputImaginary[bin] * spectrum.real[bin];
      }
      fft(real, imaginary, true);
      const count = Math.min(fftSize, outputs[ear].length - offset);
      for (let sample = 0; sample < count; sample++) outputs[ear][offset + sample] += real[sample];
    }
  }
}

function renderLayout(layoutId, directory, wetWeight) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "hrtf-set.json"), "utf8"));
  const { layout, buses } = renderBuses(layoutId);
  const outputs = [new Float64Array(captureLength + 8191), new Float64Array(captureLength + 8191)];
  for (let bus = 0; bus < layout.length; bus++) {
    if (layout[bus].isLfe) continue;
    convolveBus(buses[bus], loadIr(directory, manifest, layout[bus], wetWeight), outputs);
  }
  return outputs.map((output) => output.subarray(preRoll, preRoll + (endSample - startSample)));
}

// ---- 精确复刻 sda-final-peak-guard 的增益算法，输出逐样本 gain 轨迹 ----
function limiterGainTrace(outputs, makeupGain) {
  const ceiling = 10 ** (-1 / 20);
  const lookahead = 240; // 5ms @48k
  const releaseCoeff = Math.exp(-1 / 4800); // 100ms
  let gain = 1;
  let attackTarget = 1;
  let attackStep = 0;
  let hold = 0;
  const trace = new Float32Array(outputs[0].length);
  for (let sample = 0; sample < outputs[0].length; sample++) {
    const peak = Math.max(Math.abs(outputs[0][sample] * makeupGain), Math.abs(outputs[1][sample] * makeupGain));
    const target = peak > ceiling ? ceiling / peak : 1;
    if (target < attackTarget) {
      const nextStep = (target - gain) / lookahead;
      attackStep = gain > attackTarget ? Math.min(attackStep, nextStep) : nextStep;
      attackTarget = target;
    }
    if (target < 1) hold = lookahead;
    if (gain > attackTarget) {
      gain = Math.max(attackTarget, gain + attackStep);
      if (gain === attackTarget) attackStep = 0;
    } else if (hold > 0) hold--;
    else {
      gain = 1 - (1 - gain) * releaseCoeff;
      attackTarget = gain;
    }
    trace[sample] = gain;
  }
  return trace;
}

// ---- 分箱分析：100ms/箱，GR 统计 + 对象运动强度 ----
const binSamples = 4800;
function analyze(layoutId, outputs) {
  const bins = Math.floor(outputs[0].length / binSamples);
  const makeupOn = limiterGainTrace(outputs, 10 ** (6 / 20));
  const makeupOff = limiterGainTrace(outputs, 1);
  // 每箱对象事件数与位移
  const binEvents = new Float64Array(bins);
  const binMotion = new Float64Array(bins);
  for (const id of objectIds) {
    const updates = events.get(id).sort((a, b) => a.samplePos - b.samplePos);
    for (let i = 1; i < updates.length; i++) {
      const at = updates[i].samplePos - startSample;
      if (at < 0 || at >= bins * binSamples) continue;
      const bin = Math.floor(at / binSamples);
      binEvents[bin]++;
      const a = updates[i - 1];
      const b = updates[i];
      if (a.hasPos && b.hasPos) {
        binMotion[bin] += Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
      }
    }
  }
  const rows = [];
  for (let bin = 0; bin < bins; bin++) {
    const from = bin * binSamples;
    let minOn = 1, minOff = 1, sumOn = 0;
    for (let s = from; s < from + binSamples; s++) {
      minOn = Math.min(minOn, makeupOn[s]);
      minOff = Math.min(minOff, makeupOff[s]);
      sumOn += makeupOn[s];
    }
    rows.push({
      t: +(from / 48000).toFixed(1),
      grMinOnDb: +(20 * Math.log10(minOn)).toFixed(2),
      grMeanOnDb: +(20 * Math.log10(sumOn / binSamples)).toFixed(3),
      grMinOffDb: +(20 * Math.log10(minOff)).toFixed(2),
      events: binEvents[bin],
      motion: +binMotion[bin].toFixed(3),
    });
  }
  // 汇总
  const reduced = (trace) => {
    let count = 0;
    for (let s = 0; s < trace.length; s++) if (trace[s] < 0.999) count++;
    return (100 * count / trace.length).toFixed(1);
  };
  // 深度下探事件：gain 跌破 -3dB 的次数（穿越计数）
  const dips = (trace, threshold) => {
    let count = 0;
    let below = false;
    for (let s = 0; s < trace.length; s++) {
      const gr = 20 * Math.log10(trace[s]);
      if (!below && gr < threshold) { count++; below = true; }
      else if (below && gr > threshold + 1) below = false;
    }
    return count;
  };
  const minOf = (trace) => {
    let m = 1;
    for (let s = 0; s < trace.length; s++) m = Math.min(m, trace[s]);
    return m;
  };
  console.log(`\n=== ${layoutId} limiter 汇总 ===`);
  console.log(`+6dB: GR 时间占比 ${reduced(makeupOn)}%, 深度下探(<-3dB) ${dips(makeupOn, -3)} 次, (<-6dB) ${dips(makeupOn, -6)} 次, 最深 ${(20 * Math.log10(minOf(makeupOn))).toFixed(1)}dB`);
  console.log(` 0dB: GR 时间占比 ${reduced(makeupOff)}%, 深度下探(<-3dB) ${dips(makeupOff, -3)} 次, (<-6dB) ${dips(makeupOff, -6)} 次, 最深 ${(20 * Math.log10(minOf(makeupOff))).toFixed(1)}dB`);
  // 运动 vs GR 相关性（皮尔逊）
  const xs = rows.map((r) => r.motion);
  const ys = rows.map((r) => r.grMeanOnDb);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
  console.log(`对象运动强度 与 平均GR 的皮尔逊相关: ${corr.toFixed(3)}`);
  // GR 最深的 10 箱
  const worst = [...rows].sort((a, b) => a.grMinOnDb - b.grMinOnDb).slice(0, 10);
  console.log("GR 最深的 10 个 100ms 箱 (+6dB):");
  console.table(worst);
  return { rows, corr };
}

const hrtfDir = "apps/web/public/hrtf";
const out714 = renderLayout("7.1.4", hrtfDir, 0.04);
const result = analyze("7.1.4", out714);
writeFileSync("tmp/object-motion-limiter.json", JSON.stringify(result, null, 2));
