/** Pure object-control helpers shared by the UI and player tests. */

import type { ObjectEvent } from "@sda/core";
import type { VisualObject } from "./player.js";

export function placeholderVisualObject(id: number): VisualObject {
  return { id, pos: [0, 0, 0], hasPos: false, size: [0, 0, 0], gainDb: 0, anchor: "room", distanceM: null, distanceInfinite: false };
}

export function visualObjectFromEvent(event: ObjectEvent): VisualObject {
  return {
    id: event.id,
    pos: event.pos,
    hasPos: event.hasPos,
    size: event.size,
    gainDb: event.gainDb,
    anchor: event.anchor,
    distanceM: event.distanceM,
    distanceInfinite: event.distanceInfinite,
  };
}

export function nextSoloMuteSet(
  objectIds: readonly number[],
  currentMuted: ReadonlySet<number>,
  id: number,
): Set<number> {
  const isCurrentSolo =
    objectIds.length > 1 &&
    objectIds.filter((objectId) => !currentMuted.has(objectId)).length === 1 &&
    !currentMuted.has(id);
  if (isCurrentSolo) return new Set();
  return new Set(objectIds.filter((objectId) => objectId !== id));
}
