import { contextBridge, ipcRenderer } from "electron";
const call = (action, key) => ipcRenderer.invoke("arena-native-arcade", { action, ...(key === undefined ? {} : { key }) });
contextBridge.exposeInMainWorld("arenaNativeArcade", Object.freeze({
  inspect: () => call("inspect"),
  probe: () => call("probe"),
  install: key => call("install", key),
  launch: key => call("launch", key),
  stop: key => call("stop", key),
  remove: key => call("remove", key),
  cancel: () => call("cancel"),
  buildRepositorySource: token => call("build-source", token),
  selectRepositoryVersion: key => call("select-version", key),
  installRepositoryRelease: selection => call("install-release", selection),
  resetBuildTool: id => call("reset-build-tool", id),
  workshop: data => ipcRenderer.invoke("arena-native-mod-workshop", data),
}));
