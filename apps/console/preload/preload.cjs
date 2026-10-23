const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('spool', {
  invoke: async () => ({})
});
