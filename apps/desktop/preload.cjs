/** Preload: expose the minimal file-access bridge to the web build. */
const { contextBridge, ipcRenderer } = require("electron");

const rendererModeArg = process.argv.find((arg) => arg.startsWith("--sda-electron-renderer="));
const rendererMode = rendererModeArg?.split("=", 2)[1] ?? "swiftshader";
const electron3D = rendererMode !== "2d";

contextBridge.exposeInMainWorld("sdaDesktop", {
  electron3D,
  rendererMode,
  pickFile: () => ipcRenderer.invoke("sda:pick-file"),
  openPath: (filePath) => ipcRenderer.invoke("sda:open-path", filePath),
  readSlice: (id, offset, length) => ipcRenderer.invoke("sda:read-slice", id, offset, length),
  close: (id) => ipcRenderer.invoke("sda:close", id),
  onOpenFile: (cb) => ipcRenderer.on("sda:open-file", (_e, p) => cb(p)),
});
