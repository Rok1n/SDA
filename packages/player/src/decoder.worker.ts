/**
 * Decoder worker script — runs demux + wasm decode off the UI thread.
 * Loaded as a module worker; messages:
 *   in:  { type: "init", wasmUrl }         → init wasm
 *        { type: "open", codec, kind }     → create decoder + demuxer
 *        { type: "push", chunk }           → container bytes (transferable)
 *   out: { type: "track", ... }            → discovered audio track
 *        { type: "frame", frame }          → decoded frame (channels transferred)
 *        { type: "error", message }
 */

import { initCore, SdaDecoder, type CodecName, type DecodedFrameData, type ObjectEvent } from "@sda/core";
import { createDemuxer, sniffContainer, type BinauralRenderMetadata, type ContainerKind, type Demuxer } from "@sda/demux";
import { canCoalesceObjectEvent } from "./control.js";

/** Minimal worker global typing (avoids DOM/WebWorker lib conflicts). */
declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let decoder: SdaDecoder | null = null;
let demuxer: Demuxer | null = null;
const lastObjectTargets = new Map<number, ObjectEvent>();

function compactObjectEvents(frame: DecodedFrameData): void {
  const objectIds = new Set<number>();
  for (const declaration of frame.objectChannels) objectIds.add(declaration.id);
  if (!frame.labels.some((label) => label.startsWith("Obj_"))) lastObjectTargets.clear();
  else if (objectIds.size > 0) {
    for (const id of lastObjectTargets.keys()) {
      if (!objectIds.has(id)) lastObjectTargets.delete(id);
    }
  }
  frame.events = frame.events.filter((event) => {
    if (canCoalesceObjectEvent(lastObjectTargets.get(event.id), event)) return false;
    lastObjectTargets.set(event.id, event);
    return true;
  });
}

function postFrame(frame: DecodedFrameData): void {
  compactObjectEvents(frame);
  self.postMessage(
    { type: "frame", frame },
    frame.channels.map((c) => c.buffer),
  );
}

function drainFrames(): void {
  if (!decoder) return;
  while (true) {
    const frame = decoder.nextFrame();
    if (!frame) break;
    postFrame(frame);
  }
  for (const message of decoder.drainErrors()) {
    self.postMessage({ type: "error", message });
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    switch (msg.type) {
    case "init": {
      await initCore();
      self.postMessage({ type: "ready" });
      break;
    }
    case "open": {
      decoder?.free();
      decoder = new SdaDecoder(msg.codec as CodecName);
      demuxer = null; // created on first push, after sniffing
      lastObjectTargets.clear();
      break;
    }
    case "flush": {
      demuxer?.flush();
      drainFrames();
      self.postMessage({ type: "flushed" });
      break;
    }
    case "push": {
      if (!decoder) break;
      const chunk = new Uint8Array(msg.chunk as ArrayBuffer);
      if (!demuxer) {
        const kind: ContainerKind = msg.kind ?? sniffContainer(chunk);
        demuxer = createDemuxer(kind, {
          onTrack: (t) => self.postMessage(
            { type: "track", track: t },
            t.coverArt ? [t.coverArt.bytes.buffer] : [],
          ),
          onPacket: (p) => {
            for (const au of p.frames) decoder!.push(au);
            drainFrames();
          },
          onError: (m) => self.postMessage({ type: "error", message: m }),
          onBinauralMetadata: (metadata: BinauralRenderMetadata) => self.postMessage({ type: "binaural-metadata", metadata }),
        });
      }
      demuxer.push(chunk);
      drainFrames();
      break;
    }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

export {};
