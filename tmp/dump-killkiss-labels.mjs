//  dump KiLLKiSS ec-3 声道标签与床结构
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const MP4Box = require("../node_modules/.pnpm/mp4box@0.5.4/node_modules/mp4box/dist/mp4box.all.js");
const core = await import(pathToFileURL(path.resolve("packages/core/pkg-node/sda_core.cjs")).href);

const sourcePath = "C:/Users/legendshop/Downloads/01. KiLLKiSS.m4a";
const bytes = readFileSync(sourcePath);
const file = MP4Box.createFile();
const accessUnits = [];
file.onReady = (info) => {
  const track = info.audioTracks.find((candidate) => candidate.codec === "ec-3");
  file.setExtractionOptions(track.id, null, { nbSamples: 1000 });
  file.start();
};
file.onSamples = (_id, _user, samples) => accessUnits.push(...samples.map((sample) => sample.data));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
buffer.fileStart = 0;
file.appendBuffer(buffer);
file.flush();

const decoder = new core.SdaDecoder("eac3");
let dumped = 0;
for (const accessUnit of accessUnits) {
  decoder.push(accessUnit);
  for (let frame = decoder.nextFrame(); frame; frame = decoder.nextFrame()) {
    if (dumped < 3) {
      console.log("labels:", JSON.stringify(frame.labels));
      console.log("objectChannels:", frame.objectChannelsJson.slice(0, 400));
      console.log("channels:", frame.channelCount ?? frame.labels.length);
      dumped++;
    }
    frame.free();
  }
  if (dumped >= 3) break;
}
