// Smoke test: decode the harletty-bridge JOC (E-AC-3 Atmos) test vector
// through the WASM core and dump frames + object events.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(here, "../pkg-node/sda_core.js")).href);
const sample = join(
  here,
  "../../../harletty-bridge/eac3/tests/data/short_packet_independent_joc.bin",
);

const data = readFileSync(sample);
console.log(`input: ${data.length} bytes`);

const dec = new core.SdaDecoder("eac3");
dec.push(data);

let frames = 0;
let eventCount = 0;
let firstLabels = null;
while (true) {
  const frame = dec.nextFrame();
  if (!frame) break;
  frames++;
  const labels = frame.labels;
  firstLabels ??= labels;
  const events = JSON.parse(frame.eventsJson);
  eventCount += events.length;
  if (frames <= 3 || events.length > 0) {
    console.log(
      `frame #${frames}: ${frame.codec} ${frame.sampleRate}Hz pos=${frame.samplePos} ` +
        `ch=${frame.channelCount} samples=${frame.samplesPerChannel} ` +
        `labels=[${labels.join(",")}] events=${events.length}`,
    );
    for (const ev of events.slice(0, 4)) {
      console.log(
        `  event id=${ev.id} pos=(${ev.pos.map((v) => v.toFixed(2)).join(",")}) ` +
          `hasPos=${ev.hasPos} gain=${ev.gainDb}dB size=(${ev.size.join(",")}) ramp=${ev.rampDuration}`,
      );
    }
  }
  // sanity: PCM actually present
  const ch0 = frame.channel(0);
  if (!ch0 || ch0.length === 0) throw new Error("empty channel 0");
}
const errors = dec.drainErrors();
console.log(`\nframes=${frames} totalEvents=${eventCount} errors=${errors.length}`);
if (errors.length) console.log(errors.slice(0, 5));
if (frames === 0) throw new Error("no frames decoded");
console.log("OK");
