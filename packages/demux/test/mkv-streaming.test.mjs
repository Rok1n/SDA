import assert from "node:assert/strict";
import { MkvDemuxer } from "../src/mkv.ts";

const concat = (...parts) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const idBytes = (id) => {
  const bytes = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (id >>> shift) & 0xff;
    if (byte || bytes.length > 0) bytes.push(byte);
  }
  return Uint8Array.from(bytes);
};

const vint = (value) => {
  for (let length = 1; length <= 4; length++) {
    if (value < 2 ** (7 * length) - 1) {
      const bytes = new Uint8Array(length);
      let rest = value;
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = rest & 0xff;
        rest = Math.floor(rest / 256);
      }
      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  }
  throw new Error("test EBML value is too large");
};

const element = (id, payload) => concat(idBytes(id), vint(payload.length), payload);
const uint = (value) => Uint8Array.of(value);
const text = (value) => new TextEncoder().encode(value);
const float64 = (value) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return bytes;
};

const audioTrack = (number, codecId) => element(0xae, concat(
  element(0xd7, uint(number)),
  element(0x83, uint(2)),
  element(0x86, text(codecId)),
  element(0xe1, concat(
    element(0xb5, float64(48000)),
    element(0x9f, uint(8)),
  )),
));

const simpleBlock = (track, payload, timecode = 0) => element(0xa3, concat(
  vint(track),
  Uint8Array.of((timecode >> 8) & 0xff, timecode & 0xff, 0x80),
  payload,
));

const info = element(0x1549a966, concat(
  element(0x2ad7b1, Uint8Array.of(0x0f, 0x42, 0x40)),
  element(0x4489, float64(2000)),
  element(0x7ba9, text("Streaming fixture")),
));
const tracks = element(0x1654ae6b, concat(
  audioTrack(1, "A_TRUEHD"),
  audioTrack(2, "A_EAC3"),
));
const videoPayload = new Uint8Array(200_000).fill(0x55);
const cluster = element(0x1f43b675, concat(
  element(0xe7, uint(5)),
  simpleBlock(3, videoPayload),
  simpleBlock(2, Uint8Array.of(9, 9, 9)),
  simpleBlock(1, Uint8Array.of(1, 2, 3, 4), 7),
));
const segment = element(0x18538067, concat(info, tracks, cluster));
const fixture = concat(element(0x1a45dfa3, new Uint8Array(0)), segment);

const discovered = [];
const packets = [];
const errors = [];
const demuxer = new MkvDemuxer({
  onTrack: (track) => discovered.push(track),
  onPacket: (packet) => packets.push(packet),
  onError: (message) => errors.push(message),
});

// Deliberately split every header and the large skipped video block at odd boundaries.
const chunkSizes = [1, 2, 5, 3, 11, 257, 4093, 17, 65536];
let offset = 0;
let chunkIndex = 0;
while (offset < fixture.length) {
  const end = Math.min(fixture.length, offset + chunkSizes[chunkIndex % chunkSizes.length]);
  demuxer.push(fixture.subarray(offset, end));
  offset = end;
  chunkIndex++;
}

assert.equal(errors.length, 0);
assert.equal(discovered.length, 1, "only the first supported audio track is selected");
assert.equal(discovered[0].codec, "truehd");
assert.equal(discovered[0].sampleRate, 48000);
assert.equal(discovered[0].channels, 8);
assert.equal(discovered[0].durationSec, 2);
assert.equal(discovered[0].title, "Streaming fixture");
assert.equal(packets.length, 1, "video and alternate audio blocks are ignored");
assert.equal(packets[0].trackNumber, 1);
assert.equal(packets[0].timestampMs, 12);
assert.deepEqual([...packets[0].frames[0]], [1, 2, 3, 4]);

const reusedPackets = [];
const reusedDemuxer = new MkvDemuxer({ onPacket: (packet) => reusedPackets.push(packet) });
const sharedChunk = new Uint8Array(4096);
for (let start = 0; start < fixture.length; start += sharedChunk.length) {
  const length = Math.min(sharedChunk.length, fixture.length - start);
  sharedChunk.set(fixture.subarray(start, start + length), 0);
  reusedDemuxer.push(sharedChunk.subarray(0, length));
}
assert.equal(reusedPackets.length, 1, "push() retains an owned copy of an incomplete tail");
assert.deepEqual([...reusedPackets[0].frames[0]], [1, 2, 3, 4]);

console.log("MKV streaming tests passed");
