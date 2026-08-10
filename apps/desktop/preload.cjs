/** Preload: expose the minimal file-access bridge to the web build. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sdaDesktop", {
  pickFile: () => ipcRenderer.invoke("sda:pick-file"),
  openPath: (filePath) => ipcRenderer.invoke("sda:open-path", filePath),
  readSlice: (id, offset, length) => ipcRenderer.invoke("sda:read-slice", id, offset, length),
  close: (id) => ipcRenderer.invoke("sda:close", id),
  onOpenFile: (cb) => ipcRenderer.on("sda:open-file", (_e, p) => cb(p)),
});
