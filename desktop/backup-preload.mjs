import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("arenaBackupDialog", {
  submit: value => ipcRenderer.send("arena-backup-passphrase", value),
  submitScope: value => ipcRenderer.send("arena-backup-scope-submit", value),
  cancel: () => ipcRenderer.send("arena-backup-cancel"),
});
