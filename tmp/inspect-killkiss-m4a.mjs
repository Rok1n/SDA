import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MP4Box = require("../node_modules/.pnpm/mp4box@0.5.4/node_modules/mp4box/dist/mp4box.all.js");
const sourcePath = process.argv[2] ?? "C:/Users/legendshop/Downloads/01. KiLLKiSS.m4a";
const source = readFileSync(sourcePath);
const core = await import(pathToFileURL(join(here, "../packages/core/pkg-node/sda_core.cjs")).href);
const mp4 = MP4Box.createFile();
const accessUnits = [];
mp4.onReady = (info) => {
  const track = info.audioTracks.find((candidate) => candidate.codec === "ec-3");
  if (!track) throw new Error("附件没有 ec-3 音轨");
  mp4.setExtractionOptions(track.id, null, { nbSamples: 1000 });
  mp4.start();
};
mp4.onSamples = (_id, _user, samples) => accessUnits.push(...samples.map((sample) => sample.data));
const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
buffer.fileStart = 0;
mp4.appendBuffer(buffer);
mp4.flush();

const decoder = new core.SdaDecoder("eac3");
const objectDeclarations = new Map();
const bedLabels = new Set();
let frames = 0;
let objectFrames = 0;
let events = 0;
let firstObjectFrame = null;
for (const accessUnit of accessUnits) {
  decoder.push(accessUnit);
  for (let frame = decoder.nextFrame(); frame; frame = decoder.nextFrame()) {
    frames++;
    for (const label of frame.rawBedLabels) bedLabels.add(label);
    const declarations = JSON.parse(frame.objectChannelsJson);
    for (const declaration of declarations) objectDeclarations.set(declaration.id, declaration.channel);
    const frameEvents = JSON.parse(frame.eventsJson);
    events += frameEvents.length;
    if (declarations.length || frameEvents.length) {
      objectFrames++;
      firstObjectFrame ??= {
        samplePos: frame.samplePos,
        labels: frame.labels,
        rawBedLabels: frame.rawBedLabels,
        objectChannels: declarations,
        events: frameEvents.slice(0, 3),
      };
    }
    frame.free();
  }
}
const errors = decoder.drainErrors();
console.log(JSON.stringify({
  accessUnits: accessUnits.length,
  decodedFrames: frames,
  objectFrames,
  rawBedLabels: [...bedLabels],
  objectDeclarations: [...objectDeclarations.entries()].map(([id, channel]) => ({ id, channel })),
  totalObjectEvents: events,
  firstObjectFrame,
  errors: errors.slice(0, 10),
  errorCount: errors.length,
}, null, 2));
