import assert from "node:assert/strict";
import { nextSoloMuteSet, placeholderVisualObject, visualObjectFromEvent } from "../src/control.ts";

const objects = [10, 11, 12];

assert.deepEqual([...nextSoloMuteSet(objects, new Set(), 11)], [10, 12]);
assert.deepEqual([...nextSoloMuteSet(objects, new Set([10, 12]), 11)], []);
assert.deepEqual([...nextSoloMuteSet(objects, new Set([10, 12]), 11)], []);
assert.deepEqual([...nextSoloMuteSet(objects, new Set([11]), 11)], [10, 12]);

assert.deepEqual(placeholderVisualObject(42), {
  id: 42,
  pos: [0, 0, 0],
  hasPos: false,
  size: [0, 0, 0],
  gainDb: 0,
});
assert.deepEqual(
  visualObjectFromEvent({
    id: 42,
    samplePos: 0,
    hasPos: true,
    pos: [0.1, -0.2, 0.3],
    gainDb: -2,
    size: [0.2, 0.3, 0.4],
    rampDuration: 128,
  }),
  { id: 42, pos: [0.1, -0.2, 0.3], hasPos: true, size: [0.2, 0.3, 0.4], gainDb: -2 },
);

console.log("player control tests: OK");
