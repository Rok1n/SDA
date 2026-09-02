const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const SOUNDSTAGE_MAGIC = 0x54485353;
const SOUNDSTAGE_STATE = path.join(process.env.ProgramData || "C:\\ProgramData", "SoundStage", "head-tracking-state.bin");
const GLOBAL_PIPE = "\\\\.\\pipe\\SDA.GlobalAudio";

let windowRef = null;
let pose = emptyPose();
let scene = emptyScene();
let pipe = null;
let pipeBuffer = "";
let nextRequestId = 1;
const pending = new Map();

function emptyPose() {
  return { available: false, live: false, source: null, mode: "unknown", yawDeg: 0, pitchDeg: 0, rollDeg: 0, ageMs: null };
}

function emptyScene(message = "SDA global audio engine unavailable") {
  return {
    connected: false,
    renderingEnabled: false,
    headTrackingEnabled: false,
    layoutId: null,
    activeStereoStreams: 0,
    activeMultichannelStreams: 0,
    objectMetadataAvailable: false,
    sources: [],
    message,
  };
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function validateScene(value) {
  if (!value || typeof value !== "object") return emptyScene("Invalid global telemetry");
  const sources = Array.isArray(value.sources) ? value.sources.slice(0, 128).flatMap((source, index) => {
    if (!source || typeof source !== "object" || !Array.isArray(source.position) || source.position.length !== 3) return [];
    const position = source.position.map((v) => finite(Number(v)));
    return [{
      id: String(source.id ?? index).slice(0, 128),
      label: String(source.label ?? source.id ?? index).slice(0, 64),
      kind: source.kind === "dynamic-object" ? "dynamic-object" : "bed-channel",
      position,
      peakDbfs: finite(Number(source.peakDbfs), -120),
      rmsDbfs: finite(Number(source.rmsDbfs), -120),
      active: source.active === true,
    }];
  }) : [];
  return {
    connected: true,
    renderingEnabled: value.renderingEnabled === true,
    headTrackingEnabled: value.headTrackingEnabled === true,
    layoutId: typeof value.layoutId === "string" ? value.layoutId.slice(0, 32) : null,
    activeStereoStreams: Math.max(0, Math.trunc(finite(Number(value.activeStereoStreams)))),
    activeMultichannelStreams: Math.max(0, Math.trunc(finite(Number(value.activeMultichannelStreams)))),
    objectMetadataAvailable: value.objectMetadataAvailable === true,
    sources,
    message: typeof value.message === "string" ? value.message.slice(0, 256) : null,
  };
}

function readSoundStagePose() {
  try {
    const bytes = fs.readFileSync(SOUNDSTAGE_STATE);
    if (bytes.length < 40 || bytes.readUInt32LE(0) !== SOUNDSTAGE_MAGIC || bytes.readUInt32LE(4) !== 1) return emptyPose();
    const sequence = bytes.readInt32LE(8);
    if ((sequence & 1) !== 0) return pose;
    const modeValue = bytes.readInt32LE(12);
    const timestampMs = Number(bytes.readBigInt64LE(32));
    const ageMs = Math.max(0, Date.now() - timestampMs);
    const mode = modeValue === 0 ? "off" : modeValue === 1 ? "fixed" : modeValue === 2 ? "tracked" : "unknown";
    return {
      available: true,
      live: mode === "tracked" && ageMs < 1500,
      source: "SoundStage AirPods AACP",
      mode,
      yawDeg: finite(bytes.readFloatLE(16)),
      pitchDeg: finite(bytes.readFloatLE(20)),
      rollDeg: finite(bytes.readFloatLE(24)),
      ageMs,
    };
  } catch {
    return emptyPose();
  }
}

function publishPose() {
  pose = readSoundStagePose();
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("sda-system:head-pose", pose);
}

function publishScene() {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("sda-system:global-scene", scene);
}

function connectGlobalPipe() {
  if (pipe && !pipe.destroyed) return;
  const socket = net.createConnection(GLOBAL_PIPE);
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    pipe = socket;
    scene = { ...scene, connected: true, message: "SDA GlobalAudio bridge connected" };
    publishScene();
    request("getStatus", {}).catch(() => {});
  });
  socket.on("data", (chunk) => {
    pipeBuffer += chunk;
    for (;;) {
      const index = pipeBuffer.indexOf("\n");
      if (index < 0) break;
      const line = pipeBuffer.slice(0, index).trim();
      pipeBuffer = pipeBuffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === "scene" || message.type === "status") {
          scene = validateScene(message.payload ?? message);
          publishScene();
        }
        if (message.type === "response" && Number.isInteger(message.requestId)) {
          const waiter = pending.get(message.requestId);
          if (waiter) {
            pending.delete(message.requestId);
            if (message.ok === false) waiter.reject(new Error(String(message.error ?? "GlobalAudio request failed")));
            else waiter.resolve(message.payload);
          }
        }
      } catch { /* invalid telemetry is dropped */ }
    }
  });
  const lost = () => {
    if (pipe === socket) pipe = null;
    scene = emptyScene("SDA GlobalAudio native bridge not connected");
    for (const waiter of pending.values()) waiter.reject(new Error("GlobalAudio disconnected"));
    pending.clear();
    publishScene();
  };
  socket.on("error", () => {});
  socket.on("close", lost);
}

function request(type, payload) {
  return new Promise((resolve, reject) => {
    if (!pipe || pipe.destroyed) return reject(new Error("SDA GlobalAudio native bridge is unavailable"));
    const requestId = nextRequestId++;
    pending.set(requestId, { resolve, reject });
    pipe.write(`${JSON.stringify({ type, requestId, payload })}\n`);
    setTimeout(() => {
      const waiter = pending.get(requestId);
      if (!waiter) return;
      pending.delete(requestId);
      reject(new Error("GlobalAudio request timed out"));
    }, 2000).unref();
  });
}

ipcMain.handle("sda-system:get-head-pose", () => pose);
ipcMain.handle("sda-system:get-global-scene", () => scene);
ipcMain.handle("sda-system:set-rendering", async (_event, enabled) => {
  if (typeof enabled !== "boolean") throw new Error("invalid rendering setting");
  const result = await request("setRenderingEnabled", { enabled });
  scene = validateScene(result ?? { ...scene, renderingEnabled: enabled });
  publishScene();
  return scene;
});
ipcMain.handle("sda-system:set-head-tracking", async (_event, enabled) => {
  if (typeof enabled !== "boolean") throw new Error("invalid head tracking setting");
  const result = await request("setHeadTrackingEnabled", { enabled });
  scene = validateScene(result ?? { ...scene, headTrackingEnabled: enabled });
  publishScene();
  return scene;
});
ipcMain.handle("sda-system:recenter", async () => {
  const result = await request("recenterHeadTracking", {});
  scene = validateScene(result ?? scene);
  publishScene();
  return scene;
});

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: "#070b13",
    title: "SDA System Audio",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "system-preload.cjs"),
    },
  });
  const page = path.join(__dirname, "web", "system.html");
  windowRef.loadFile(page);
  windowRef.on("closed", () => { windowRef = null; });
}

app.whenReady().then(() => {
  createWindow();
  publishPose();
  connectGlobalPipe();
  setInterval(publishPose, 50).unref();
  setInterval(connectGlobalPipe, 1500).unref();
});

app.on("window-all-closed", () => app.quit());
