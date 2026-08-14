import assert from "node:assert/strict";
import { SpatialRenderer } from "../src/renderer.ts";

const messages = [];
const renderer = {
  consumedSamples: 0,
  node: { port: { postMessage: (message) => messages.push(["renderer", message]) } },
  peakGuard: { port: { postMessage: (message) => messages.push(["peakGuard", message]) } },
};

SpatialRenderer.prototype.startAt.call(renderer, 144000.9);

assert.equal(renderer.consumedSamples, 144000);
assert.deepEqual(messages, [
  ["renderer", { type: "start", origin: 144000 }],
  ["peakGuard", { type: "start", origin: 144000 }],
]);

console.log("renderer startAt tests: OK");
