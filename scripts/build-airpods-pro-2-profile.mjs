#!/usr/bin/env node
/** Convert the approved AutoEq AirPods Pro 2 ANC averaged FIR to SDA f32le assets. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [inputPath, leftPath, rightPath] = process.argv.slice(2);
if (!inputPath || !leftPath || !rightPath) {
  console.error("Usage: node scripts/build-airpods-pro-2-profile.mjs <input.wav> <left.f32> <right.f32>");
  process.exit(1);
}

function parseStereoPcm16Wav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected RIFF/WAV input");
  }
  let fmt = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") fmt = buffer.subarray(start, start + size);
    if (id === "data") data = buffer.subarray(start, start + size);
    offset = start + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV is missing fmt or data chunk");
  const format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (format !== 1 || channels !== 2 || bits !== 16 || sampleRate !== 48000) {
    throw new Error(`Expected 48kHz stereo PCM16 WAV, got fmt=${format} ch=${channels} rate=${sampleRate} bits=${bits}`);
  }
  const frames = data.length / 4;
  if (!Number.isInteger(frames) || frames === 0) throw new Error("WAV has no complete stereo frames");
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = data.readInt16LE(i * 4) / 32768;
    right[i] = data.readInt16LE(i * 4 + 2) / 32768;
  }
  return { left, right, sampleRate };
}

const { left, right, sampleRate } = parseStereoPcm16Wav(readFileSync(resolve(inputPath)));
for (let i = 0; i < left.length; i++) {
  if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error(`Non-finite tap at ${i}`);
  if (left[i] !== right[i]) throw new Error(`Expected averaged L/R FIR, channels differ at tap ${i}`);
}
for (const outputPath of [leftPath, rightPath]) {
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, Buffer.from(left.buffer));
}
console.log(`Wrote identical ${left.length}-tap AirPods Pro 2 ANC averaged FIRs @ ${sampleRate}Hz`);
