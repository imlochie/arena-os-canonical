import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("arenaBackupDialog", {
  submit: value => ipcRenderer.send("arena-backup-passphrase", value),
  cancel: () => ipcRenderer.send("arena-backup-cancel"),
});
