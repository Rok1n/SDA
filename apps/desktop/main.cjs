/**
 * SDA desktop — Electron main process.
 *
 * The desktop app is the web build (apps/web/dist) plus:
 *  - native file open dialog / CLI file argument (no 4 GB File API limits —
 *    renderer reads via sda.readFileSlice IPC)
 *  - multichannel audio devices just work via Chromium (WASAPI exclusive
 *    would need a native output path; see docs for the plan)
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const isDev = process.argv.includes("--dev");
const requestedRenderer = process.env.SDA_ELECTRON_RENDERER ?? "swiftshader";
const rendererMode = ["swiftshader", "hardware", "2d"].includes(requestedRenderer)
  ? requestedRenderer
  : "swiftshader";
const enable3D = rendererMode !== "2d";
const openDevTools = process.env.SDA_OPEN_DEVTOOLS === "1" || process.argv.includes("--open-devtools");
const DEV_URL = process.env.SDA_DEV_URL ?? "http://localhost:5173";

// SwiftShader keeps the full WebGL/three.js scene without depending on the
// host GPU driver. Hardware mode is available for machines with stable drivers;
// 2d is an explicit emergency fallback only.
if (process.platform === "linux" && rendererMode === "swiftshader") {
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader-webgl");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}
if (process.platform === "linux" && rendererMode === "2d") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-3d-apis");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.disableHardwareAcceleration();
}

/** File handles the renderer has opened, id → path. */
const openFiles = new Map();
let nextFileId = 1;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0c101c",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the renderer active when the window is covered or detached.
      backgroundThrottling: false,
      additionalArguments: [`--sda-electron-renderer=${rendererMode}`],
    },
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[SDA] 页面加载失败 ${errorCode} ${errorDescription}: ${validatedURL}`);
    dialog.showErrorBox("SDA 页面加载失败", `${errorDescription}\n${validatedURL}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[SDA] renderer 退出: ${details.reason}${details.exitCode ? ` (${details.exitCode})` : ""}`);
    if (details.reason !== "clean-exit") {
      dialog.showErrorBox(
        "SDA 3D 渲染进程失败",
        `WebGL 渲染进程异常退出（${details.reason}）。可用 SDA_ELECTRON_RENDERER=2d 临时启动。`,
      );
    }
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.warn(`[SDA renderer] ${sourceId}:${line} ${message}`);
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    if (openDevTools) win.webContents.openDevTools({ mode: "detach" });
  } else {
    const candidates = [
      path.join(__dirname, "web/index.html"),
      path.join(__dirname, "../web/dist/index.html"),
    ];
    const entry = candidates.find((candidate) => fs.existsSync(candidate));
    if (!entry) {
      dialog.showErrorBox(
        "SDA 无法启动",
        "找不到网页资源。请先运行 pnpm web:build，或使用 --dev 启动开发服务器。",
      );
      app.quit();
      return;
    }
    win.loadFile(entry);
  }

  // `sda --dev movie.mkv` or double-clicked file association.
  const fileArg = process.argv.find(
    (a, i) => i > 1 && !a.startsWith("-") && fs.existsSync(a) && !a.endsWith(".cjs"),
  );
  if (fileArg) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("sda:open-file", fileArg);
    });
  }
}

ipcMain.handle("sda:pick-file", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [
      { name: "Audio / Video", extensions: ["mkv", "mka", "mp4", "m4a", "thd", "mlp", "ec3", "eac3", "ac3", "dts"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("sda:open-path", (_e, filePath) => {
  const stat = fs.statSync(filePath);
  const id = nextFileId++;
  openFiles.set(id, filePath);
  return { id, size: stat.size, name: path.basename(filePath) };
});

ipcMain.handle("sda:read-slice", (_e, id, offset, length) => {
  const filePath = openFiles.get(id);
  if (!filePath) throw new Error("unknown file id");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
});

ipcMain.handle("sda:close", (_e, id) => {
  openFiles.delete(id);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
