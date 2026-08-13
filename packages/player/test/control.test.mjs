import assert from "node:assert/strict";
import {
  canCoalesceObjectEvent,
  nextSoloMuteSet,
  placeholderVisualObject,
  sameObjectTarget,
  visualObjectFromEvent,
  withoutPendingObjectEvents,
} from "../src/control.ts";

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
  anchor: "room",
  distanceM: null,
  distanceInfinite: false,
});
assert.deepEqual(
  visualObjectFromEvent({
    id: 42,
    samplePos: 0,
    hasPos: true,
    pos: [0.1, -0.2, 0.3],
    gainDb: -2,
    size: [0.2, 0.3, 0.4],
    anchor: "room",
    distanceM: null,
    distanceInfinite: false,
    screenFactor: null,
    depthFactor: null,
    rampDuration: 128,
  }),
  {
    id: 42,
    pos: [0.1, -0.2, 0.3],
    hasPos: true,
    size: [0.2, 0.3, 0.4],
    gainDb: -2,
    anchor: "room",
    distanceM: null,
    distanceInfinite: false,
  },
);

const target = {
  id: 42,
  samplePos: 0,
  hasPos: true,
  pos: [0.1, -0.2, 0.3],
  gainDb: -2,
  size: [0.2, 0.3, 0.4],
  anchor: "room",
  distanceM: null,
  distanceInfinite: false,
  screenFactor: null,
  depthFactor: null,
  rampDuration: 128,
};
assert.equal(sameObjectTarget(target, { ...target, samplePos: 1536 }), true);
assert.equal(canCoalesceObjectEvent(target, { ...target, samplePos: 1536 }), true);
assert.equal(canCoalesceObjectEvent(target, { ...target, samplePos: 64, rampDuration: 32 }), false);
assert.equal(sameObjectTarget(target, { ...target, pos: [0.2, -0.2, 0.3] }), false);
assert.equal(sameObjectTarget(target, { ...target, gainDb: -3 }), false);

const pending = [
  { ...target, id: 41, samplePos: 0 },
  { ...target, id: 42, samplePos: 128 },
  { ...target, id: 43, samplePos: 256 },
  { ...target, id: 42, samplePos: 384 },
];
assert.deepEqual(withoutPendingObjectEvents(pending, 1, 42).map((event) => event.id), [43]);

console.log("player control tests: OK");
