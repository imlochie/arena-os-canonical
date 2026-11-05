import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("arenaBackupDialog", {
  submit: value => ipcRenderer.send("arena-backup-passphrase", value),
  submitScope: value => ipcRenderer.send("arena-backup-scope-submit", value),
  cancel: () => ipcRenderer.send("arena-backup-cancel"),
  cancelBackup: () => ipcRenderer.send("arena-backup-progress-cancel"),
  onProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("arena-backup-progress", listener);
    return () => ipcRenderer.removeListener("arena-backup-progress", listener);
  },
});
