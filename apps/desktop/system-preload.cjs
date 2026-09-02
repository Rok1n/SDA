const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sdaSystem", {
  getHeadPose: () => ipcRenderer.invoke("sda-system:get-head-pose"),
  getGlobalScene: () => ipcRenderer.invoke("sda-system:get-global-scene"),
  setRenderingEnabled: (enabled) => ipcRenderer.invoke("sda-system:set-rendering", enabled),
  setHeadTrackingEnabled: (enabled) => ipcRenderer.invoke("sda-system:set-head-tracking", enabled),
  recenterHeadTracking: () => ipcRenderer.invoke("sda-system:recenter"),
  onHeadPose: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("sda-system:head-pose", handler);
    return () => ipcRenderer.removeListener("sda-system:head-pose", handler);
  },
  onGlobalScene: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("sda-system:global-scene", handler);
    return () => ipcRenderer.removeListener("sda-system:global-scene", handler);
  },
});
