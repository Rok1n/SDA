import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const MP4Box = require("../node_modules/.pnpm/mp4box@0.5.4/node_modules/mp4box/dist/mp4box.all.js");
const core = await import(pathToFileURL(path.resolve("packages/core/pkg-node/sda_core.cjs")).href);
const renderer = require("./renderer.bundle.cjs");
const sourcePath = process.argv[2] ?? "C:/Users/legendshop/Downloads/01. KiLLKiSS.m4a";
const startSample = 55 * 48000;
const endSample = 70 * 48000;
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
    const updates = events.get(id).sort((left, right) => left.samplePos - right.samplePos);
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
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
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
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function loadIr(directory, manifest, speaker, wetWeight) {
  const legacyMirror = manifest.calibrationVersion === undefined && speaker.name === "WideRight";
  const azimuth = legacyMirror ? -speaker.azimuth : speaker.azimuth;
  const entry = manifest.positions.find((position) => position.azimuth === azimuth && position.elevation === speaker.elevation);
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
  const shift = legacy
    ? peakIndex(wet.subarray(0, wetLength), 960) - peakIndex(dry.subarray(0, dryLength))
    : 0;
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
    for (const samples of output) for (let sample = 0; sample < samples.length; sample++) samples[sample] *= scale;
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

function spectrumMetrics(outputs) {
  const fftSize = 16384;
  const power = new Float64Array(fftSize / 2 + 1);
  for (let offset = 0; offset + fftSize <= outputs[0].length; offset += fftSize) {
    const windowPower = new Float64Array(power.length);
    for (let ear = 0; ear < 2; ear++) {
      const real = new Float64Array(fftSize);
      const imaginary = new Float64Array(fftSize);
      for (let sample = 0; sample < fftSize; sample++) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * sample / (fftSize - 1));
        real[sample] = outputs[ear][offset + sample] * window;
      }
      fft(real, imaginary);
      for (let bin = 1; bin < power.length; bin++) windowPower[bin] += real[bin] ** 2 + imaginary[bin] ** 2;
    }
    for (let bin = 1; bin < power.length; bin++) power[bin] += windowPower[bin];
  }
  const bands = { low: 0, mid: 0, high: 0 };
  let weightedFrequency = 0;
  let totalPower = 0;
  for (let bin = 1; bin < power.length; bin++) {
    const frequency = bin * 48000 / fftSize;
    const value = power[bin];
    totalPower += value;
    weightedFrequency += frequency * value;
    if (frequency < 250) bands.low += value;
    else if (frequency < 4000) bands.mid += value;
    else bands.high += value;
  }
  return { bands, centroidHz: weightedFrequency / totalPower, power: totalPower };
}

function signalMetrics(outputs) {
  let energy = 0;
  let peak = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let cross = 0;
  for (let sample = 0; sample < outputs[0].length; sample++) {
    const left = outputs[0][sample];
    const right = outputs[1][sample];
    leftEnergy += left ** 2;
    rightEnergy += right ** 2;
    cross += left * right;
    energy += left ** 2 + right ** 2;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  const rms = Math.sqrt(energy / (outputs[0].length * 2));
  const spectrum = spectrumMetrics(outputs);
  return {
    rmsDb: 20 * Math.log10(rms),
    peakDb: 20 * Math.log10(peak),
    crestDb: 20 * Math.log10(peak / rms),
    lrCorrelation: cross / Math.sqrt(leftEnergy * rightEnergy),
    centroidHz: spectrum.centroidHz,
    bandsDb: Object.fromEntries(Object.entries(spectrum.bands).map(([key, value]) => [key, 10 * Math.log10(value)])),
  };
}

function limiterMetrics(outputs) {
  const ceiling = 10 ** (-1 / 20);
  const makeup = 10 ** (6 / 20);
  const lookahead = 240;
  const releaseCoeff = Math.exp(-1 / 4800);
  let gain = 1;
  let attackTarget = 1;
  let attackStep = 0;
  let hold = 0;
  let minimumGain = 1;
  let reducedSamples = 0;
  let gainSum = 0;
  for (let sample = 0; sample < outputs[0].length; sample++) {
    const peak = Math.max(Math.abs(outputs[0][sample] * makeup), Math.abs(outputs[1][sample] * makeup));
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
    if (gain < 0.999) reducedSamples++;
    minimumGain = Math.min(minimumGain, gain);
    gainSum += gain;
  }
  return {
    minimumGainReductionDb: 20 * Math.log10(minimumGain),
    meanGainReductionDb: 20 * Math.log10(gainSum / outputs[0].length),
    reducedPercent: reducedSamples * 100 / outputs[0].length,
  };
}

const candidateDirectory = process.env.SDA_HRTF_CANDIDATE;
const variants = candidateDirectory
  ? [{ name: "candidate", directory: candidateDirectory, wet: 0.04 }]
  : [
  { name: "v1-near", directory: "apps/web/public/hrtf", wet: 0.04 },
  { name: "v2-near", directory: "tmp/hrtf-calibrated-v2", wet: 0.04 },
  { name: "trim-near", directory: "tmp/hrtf-trim-candidate", wet: 0.04 },
  { name: "peak-tof-near", directory: "tmp/hrtf-peak-tof-candidate", wet: 0.04 },
  { name: "v1-dry", directory: "apps/web/public/hrtf", wet: 0 },
  { name: "v0-near", directory: "tmp/hrtf", wet: 0.04 },
  { name: "v0-dry", directory: "tmp/hrtf", wet: 0 },
];
const results = {};
for (const variant of variants) {
  results[variant.name] = {};
  for (const layoutId of ["5.1.4", "7.1.4", "9.1.4"]) {
    const outputs = renderLayout(layoutId, variant.directory, variant.wet);
    results[variant.name][layoutId] = {
      ...signalMetrics(outputs),
      limiter: limiterMetrics(outputs),
    };
    console.log(variant.name, layoutId, results[variant.name][layoutId]);
  }
}
writeFileSync("tmp/killkiss-layout-diagnostic.json", `${JSON.stringify({ windowSeconds: [55, 70], results }, null, 2)}\n`);
