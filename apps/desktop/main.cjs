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
const DEV_URL = process.env.SDA_DEV_URL ?? "http://localhost:5173";

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
      // 窗口被遮挡/失去焦点时 Chromium 会把 rAF 和定时器节流到 ~1Hz —
      // RDP 下 detach 的 devtools 很容易盖住主窗口，表现为 3D 对象移动
      // "很卡"、可视化更新一跳一跳。浏览器前台标签无此问题。
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "web/index.html"));
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
