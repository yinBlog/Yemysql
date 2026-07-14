const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 连接配置
  listConnections: () => ipcRenderer.invoke('conn:list'),
  saveConnection: (cfg) => ipcRenderer.invoke('conn:save', cfg),
  deleteConnection: (id) => ipcRenderer.invoke('conn:delete', id),

  // 连接控制
  connect: (cfg) => ipcRenderer.invoke('db:connect', cfg),
  test: (cfg) => ipcRenderer.invoke('db:test', cfg),
  disconnect: (connId) => ipcRenderer.invoke('db:disconnect', connId),
  status: (connId) => ipcRenderer.invoke('db:status', connId),

  // 元数据
  databases: (connId) => ipcRenderer.invoke('db:databases', connId),
  tables: (connId, database) => ipcRenderer.invoke('db:tables', { connId, database }),
  columns: (connId, database, table) => ipcRenderer.invoke('db:columns', { connId, database, table }),
  columnOp: (opts) => ipcRenderer.invoke('db:columnOp', opts),
  indexes: (connId, database, table) => ipcRenderer.invoke('db:indexes', { connId, database, table }),
  indexOp: (opts) => ipcRenderer.invoke('db:indexOp', opts),
  foreignKeys: (connId, database, table) => ipcRenderer.invoke('db:foreignKeys', { connId, database, table }),
  fkOp: (opts) => ipcRenderer.invoke('db:fkOp', opts),
  schemaSnapshot: (connId, database) => ipcRenderer.invoke('db:schemaSnapshot', { connId, database }),
  ddl: (connId, database, table) => ipcRenderer.invoke('db:ddl', { connId, database, table }),

  // 数据
  browse: (opts) => ipcRenderer.invoke('db:browse', opts),
  query: (connId, database, sql) => ipcRenderer.invoke('db:query', { connId, database, sql }),
  dangerOp: (opts) => ipcRenderer.invoke('db:dangerOp', opts),

  // 数据编辑
  dbColumns: (connId, database) => ipcRenderer.invoke('db:dbColumns', { connId, database }),
  updateCell: (opts) => ipcRenderer.invoke('db:update', opts),
  insertRow: (opts) => ipcRenderer.invoke('db:insert', opts),
  deleteRows: (opts) => ipcRenderer.invoke('db:delete', opts),

  // 导出 / 剪贴板
  exportFile: (opts) => ipcRenderer.invoke('export:save', opts),
  dump: (opts) => ipcRenderer.invoke('db:dump', opts),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),

  // 导入 / 文件选择
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  importPreview: (opts) => ipcRenderer.invoke('db:importPreview', opts),
  importData: (opts) => ipcRenderer.invoke('db:import', opts),
  onImportProgress: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('import:progress', fn); return () => ipcRenderer.removeListener('import:progress', fn); },

  // SQL 历史
  historyList: () => ipcRenderer.invoke('history:list'),
  historyAdd: (entry) => ipcRenderer.invoke('history:add', entry),
  historyClear: () => ipcRenderer.invoke('history:clear'),
});
