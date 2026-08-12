import assert from "node:assert/strict";
import { BwfDemuxer, decodeDbmdBinauralMetadata, sniffContainer } from "../src/index.ts";

function checksum(payload) {
  let sum = payload.length & 0xff;
  for (const byte of payload) sum = (sum + byte) & 0xff;
  return (-sum) & 0xff;
}

function dbmd(objectModes) {
  const payload = new Uint8Array(7 + 6 * 15 + objectModes.length * 2);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0xf8726fbd, true);
  view.setUint16(4, objectModes.length, true);
  payload.set(objectModes.map((mode) => ({ off: 0, near: 1, far: 2, mid: 3, "not-indicated": 4 })[mode]), 7 + 6 * 15 + objectModes.length);
  const segment = new Uint8Array(3 + payload.length + 1);
  segment[0] = 0x0a;
  segment[1] = payload.length & 0xff;
  segment[2] = payload.length >> 8;
  segment.set(payload, 3);
  segment[segment.length - 1] = checksum(payload);
  return new Uint8Array([7, 0, 0, 1, ...segment, 0]);
}

const metadata = decodeDbmdBinauralMetadata(dbmd(["off", "near", "far", "mid", "not-indicated"]));
assert.equal(metadata.available, true);
assert.deepEqual(metadata.objectModes, ["off", "near", "far", "mid", "not-indicated"]);
assert.equal(decodeDbmdBinauralMetadata(new Uint8Array([8, 0, 0, 1, 0])).available, false);

const payload = dbmd(["near"]);
const bwf = new Uint8Array(12 + 8 + payload.length);
bwf.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
bwf.set([0x64, 0x62, 0x6d, 0x64, payload.length, 0, 0, 0], 12);
bwf.set(payload, 20);
assert.equal(sniffContainer(bwf), "bwf");
let discovered;
const scanner = new BwfDemuxer({ onBinauralMetadata: (value) => { discovered = value; } });
scanner.push(bwf.subarray(0, 24));
assert.equal(discovered, undefined);
scanner.push(bwf.subarray(24));
assert.equal(discovered.available, true);
assert.deepEqual(discovered.objectModes, ["near"]);
console.log("DBMD/BWF tests passed");
