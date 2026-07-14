const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createDriver } = require('./drivers');
let xlsx = null; try { xlsx = require('xlsx'); } catch (_) {}

const isDev = process.argv.includes('--dev');

// ---------- 配置 / 历史持久化 ----------
const STORE_FILE = path.join(app.getPath('userData'), 'connections.json');
const HISTORY_FILE = path.join(app.getPath('userData'), 'sql_history.json');

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { console.error('读取失败', file, e); }
  return fallback;
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); return true; }
  catch (e) { console.error('保存失败', file, e); return false; }
}

const loadConnections = () => readJson(STORE_FILE, []);
const saveConnections = (list) => writeJson(STORE_FILE, list);

// ---------- 活动连接 ----------
const pools = new Map(); // connId -> { type, raw, driver }

async function getConn(connId) {
  const w = pools.get(connId);
  if (!w) throw new Error('未连接或连接已断开，请重新连接');
  return w;
}
async function closeWrap(w) { try { await w.driver.end(w.raw); } catch (_) {} }

const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`'; // 仅用于 MySQL 专有的 DDL/dump

// ---------- 密码加密（safeStorage / Windows DPAPI） ----------
function encEnabled() {
  try { return safeStorage && safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}
// 返回写入存储用的密码字段
function encryptPassword(plain) {
  if (plain && encEnabled()) {
    return { pwEncrypted: true, passwordEnc: safeStorage.encryptString(plain).toString('base64'), password: undefined };
  }
  return { pwEncrypted: false, passwordEnc: '', password: plain || '' };
}
// 从存储记录中取出明文密码
function decryptPassword(rec) {
  if (rec && rec.pwEncrypted && rec.passwordEnc) {
    try { return safeStorage.decryptString(Buffer.from(rec.passwordEnc, 'base64')); } catch (_) { return ''; }
  }
  return (rec && rec.password) || '';
}
// 下发给渲染进程前，去除任何密码字段
function sanitize(rec) {
  const { password, passwordEnc, pwEncrypted, ...rest } = rec;
  return { ...rest, hasPassword: !!(passwordEnc || password) };
}
// 用存储中的明文密码补全配置（用于建立连接）
function withStoredPassword(cfgOrId) {
  const id = typeof cfgOrId === 'string' ? cfgOrId : cfgOrId.id;
  const stored = loadConnections().find((c) => c.id === id);
  if (stored) return { ...stored, password: decryptPassword(stored) };
  return cfgOrId; // 未保存的（理论上不会发生）
}

// SQL 值转义（用于 dump）
function sqlEscape(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    .replace(/\x00/g, '\\0').replace(/\x1a/g, '\\Z') + "'";
}

// ---------- 窗口 ----------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'MySQL 客户端',
    backgroundColor: '#1e1e2e',
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  Menu.setApplicationMenu(null);
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 冒烟测试时由测试脚本自行创建窗口，这里跳过，只保留 IPC 处理器注册
if (process.env.MYSQL_SMOKE !== '1') {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', async () => {
  for (const w of pools.values()) { await closeWrap(w); }
  pools.clear();
  if (process.platform !== 'darwin') app.quit();
});

// ====================== 连接配置 CRUD ======================
ipcMain.handle('conn:list', () => loadConnections().map(sanitize));

ipcMain.handle('conn:save', (_e, cfg) => {
  const list = loadConnections();
  let record;
  if (cfg.id) {
    const idx = list.findIndex((c) => c.id === cfg.id);
    const prev = idx >= 0 ? list[idx] : {};
    record = { ...prev, ...cfg };
    if (cfg.password) {
      Object.assign(record, encryptPassword(cfg.password)); // 用户输入了新密码 → 重新加密
    } else {
      // 留空 → 保留原密码
      record.pwEncrypted = prev.pwEncrypted; record.passwordEnc = prev.passwordEnc; record.password = prev.password;
    }
    if (record.pwEncrypted) delete record.password;
    if (idx >= 0) list[idx] = record; else list.push(record);
  } else {
    cfg.id = 'conn_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    record = { ...cfg, ...encryptPassword(cfg.password) };
    if (record.pwEncrypted) delete record.password;
    list.push(record);
  }
  delete record.hasPassword; // 渲染层附带的只读字段，不入库
  saveConnections(list);
  return sanitize(record);
});

ipcMain.handle('conn:delete', async (_e, id) => {
  saveConnections(loadConnections().filter((c) => c.id !== id));
  if (pools.has(id)) { await closeWrap(pools.get(id)); pools.delete(id); }
  return true;
});

// ====================== 连接控制 ======================
ipcMain.handle('db:connect', async (_e, arg) => {
  try {
    const cfg = withStoredPassword(arg); // 用存储中的明文密码补全（密码不经过渲染进程）
    const type = cfg.type || 'mysql';
    const driver = createDriver(type);
    if (pools.has(cfg.id)) { await closeWrap(pools.get(cfg.id)); pools.delete(cfg.id); }
    const raw = await driver.connect(cfg);
    pools.set(cfg.id, { type, raw, driver });
    let version = '';
    try { version = await driver.version(raw); } catch (_) {}
    return { ok: true, version, type, caps: driver.caps };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('db:test', async (_e, cfg) => {
  let w = null;
  try {
    const c = { ...cfg };
    if (cfg.id && !cfg.password) {
      const stored = loadConnections().find((x) => x.id === cfg.id);
      if (stored) c.password = decryptPassword(stored);
    }
    const driver = createDriver(c.type || 'mysql');
    const raw = await driver.connect(c);
    let version = '';
    try { version = await driver.version(raw); } catch (_) {}
    try { await driver.end(raw); } catch (_) {}
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('db:disconnect', async (_e, connId) => {
  if (pools.has(connId)) { await closeWrap(pools.get(connId)); pools.delete(connId); }
  return { ok: true };
});

ipcMain.handle('db:status', (_e, connId) => ({ connected: pools.has(connId) }));

// ====================== 元数据 ======================
ipcMain.handle('db:databases', async (_e, connId) => {
  try { const w = await getConn(connId); return { ok: true, data: await w.driver.databases(w.raw) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db:tables', async (_e, { connId, database }) => {
  try { const w = await getConn(connId); return { ok: true, data: await w.driver.tables(w.raw, database) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db:columns', async (_e, { connId, database, table }) => {
  try { const w = await getConn(connId); return { ok: true, data: await w.driver.columns(w.raw, database, table) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db:indexes', async (_e, { connId, database, table }) => {
  try { const w = await getConn(connId); return { ok: true, data: await w.driver.indexesRaw(w.raw, database, table) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ====================== 查询 ======================
ipcMain.handle('db:query', async (_e, { connId, database, sql }) => {
  const start = Date.now();
  try {
    const w = await getConn(connId);
    if (database) { try { await w.driver.useDatabase(w.raw, database); } catch (_) {} }
    const r = await w.driver.query(w.raw, sql);
    const elapsed = Date.now() - start;
    if (r.kind === 'select') return { ok: true, type: 'select', columns: r.columns, rows: r.rows, rowCount: r.rows.length, elapsed };
    return { ok: true, type: 'modify', affectedRows: r.affectedRows, insertId: r.insertId, elapsed };
  } catch (e) {
    return { ok: false, error: e.message, elapsed: Date.now() - start };
  }
});

ipcMain.handle('db:browse', async (_e, { connId, database, table, limit = 200, offset = 0, orderBy, orderDir, where }) => {
  const start = Date.now();
  try {
    const w = await getConn(connId);
    const r = await w.driver.browse(w.raw, { db: database, table, limit, offset, orderBy, orderDir, where });
    return { ok: true, columns: r.columns, rows: r.rows, total: r.total, limit: Number(limit), offset: Number(offset), elapsed: Date.now() - start };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db:ddl', async (_e, { connId, database, table }) => {
  try { const w = await getConn(connId); return { ok: true, ddl: await w.driver.ddl(w.raw, database, table) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 字段（列）增 / 改 / 删（MySQL/MariaDB）
function buildColumnDef(def) {
  if (!def.name) throw new Error('字段名不能为空');
  if (!def.type) throw new Error('字段类型不能为空');
  let s = ident(def.name) + ' ' + def.type;
  s += def.nullable ? ' NULL' : ' NOT NULL';
  if (def.defaultProvided) {
    s += ' DEFAULT ' + (def.defaultRaw ? def.defaultValue : sqlEscape(def.defaultValue));
  }
  if (def.comment) s += ' COMMENT ' + sqlEscape(def.comment);
  return s;
}
ipcMain.handle('db:columnOp', async (_e, { connId, database, table, op, def }) => {
  try {
    const w = await getConn(connId);
    if (!w.driver.caps.alter) throw new Error('该数据库类型暂不支持可视化改字段，请用 SQL');
    const conn = w.raw;
    const tbl = `${ident(database)}.${ident(table)}`;
    let sql;
    if (op === 'add') {
      let pos = '';
      if (def.first) pos = ' FIRST';
      else if (def.after) pos = ' AFTER ' + ident(def.after);
      sql = `ALTER TABLE ${tbl} ADD COLUMN ${buildColumnDef(def)}${pos}`;
    } else if (op === 'modify') {
      sql = `ALTER TABLE ${tbl} CHANGE ${ident(def.oldName || def.name)} ${buildColumnDef(def)}`;
    } else if (op === 'drop') {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0,
        title: '删除字段', message: `确定要从 ${database}.${table} 删除字段 ${def.name} 吗？`,
        detail: '该列及其所有数据将被永久删除，不可恢复！',
      });
      if (response !== 1) return { ok: false, canceled: true };
      sql = `ALTER TABLE ${tbl} DROP COLUMN ${ident(def.name)}`;
    } else throw new Error('未知操作');
    await conn.query(sql);
    return { ok: true, sql };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 索引增 / 删（含主键）
ipcMain.handle('db:indexOp', async (_e, { connId, database, table, op, def }) => {
  try {
    const w = await getConn(connId);
    if (!w.driver.caps.index) throw new Error('该数据库类型暂不支持可视化索引管理，请用 SQL');
    const conn = w.raw;
    const tbl = `${ident(database)}.${ident(table)}`;
    let sql;
    if (op === 'add') {
      if (!def.columns || !def.columns.length) throw new Error('请至少选择一个字段');
      const cols = def.columns.map(ident).join(', ');
      if (def.type === 'PRIMARY') {
        sql = `ALTER TABLE ${tbl} ADD PRIMARY KEY (${cols})`;
      } else {
        if (!def.name) throw new Error('索引名不能为空');
        const kind = def.type === 'UNIQUE' ? 'UNIQUE INDEX' : def.type === 'FULLTEXT' ? 'FULLTEXT INDEX' : 'INDEX';
        sql = `ALTER TABLE ${tbl} ADD ${kind} ${ident(def.name)} (${cols})`;
      }
    } else if (op === 'drop') {
      const isPk = def.name === 'PRIMARY';
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0,
        title: isPk ? '删除主键' : '删除索引',
        message: isPk ? `确定要删除 ${database}.${table} 的主键吗？` : `确定要删除索引 ${def.name} 吗？`,
        detail: isPk ? '删除主键后该表将失去主键（数据浏览将变为只读）。' : '该索引将被删除。',
      });
      if (response !== 1) return { ok: false, canceled: true };
      sql = isPk ? `ALTER TABLE ${tbl} DROP PRIMARY KEY` : `ALTER TABLE ${tbl} DROP INDEX ${ident(def.name)}`;
    } else throw new Error('未知操作');
    await conn.query(sql);
    return { ok: true, sql };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 外键查询 / 增删
ipcMain.handle('db:foreignKeys', async (_e, { connId, database, table }) => {
  try {
    const w = await getConn(connId);
    if (!w.driver.caps.fk) return { ok: true, data: [], unsupported: true };
    const conn = w.raw;
    const [rows] = await conn.query(`
      SELECT kcu.CONSTRAINT_NAME as name, kcu.COLUMN_NAME as col,
             kcu.REFERENCED_TABLE_NAME as refTable, kcu.REFERENCED_COLUMN_NAME as refCol,
             kcu.ORDINAL_POSITION as pos, rc.UPDATE_RULE as onUpdate, rc.DELETE_RULE as onDelete
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.TABLE_NAME = kcu.TABLE_NAME
      WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`, [database, table]);
    return { ok: true, data: rows };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('db:fkOp', async (_e, { connId, database, table, op, def }) => {
  try {
    const w = await getConn(connId);
    if (!w.driver.caps.fk) throw new Error('该数据库类型暂不支持可视化外键管理，请用 SQL');
    const conn = w.raw;
    const tbl = `${ident(database)}.${ident(table)}`;
    let sql;
    if (op === 'add') {
      if (!def.column || !def.refTable || !def.refColumn) throw new Error('请填写本表字段、引用表与引用字段');
      const name = def.name ? `CONSTRAINT ${ident(def.name)} ` : '';
      sql = `ALTER TABLE ${tbl} ADD ${name}FOREIGN KEY (${ident(def.column)}) REFERENCES ${ident(database)}.${ident(def.refTable)} (${ident(def.refColumn)})`;
      const rules = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION'];
      if (def.onDelete && rules.includes(def.onDelete)) sql += ` ON DELETE ${def.onDelete}`;
      if (def.onUpdate && rules.includes(def.onUpdate)) sql += ` ON UPDATE ${def.onUpdate}`;
    } else if (op === 'drop') {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0,
        title: '删除外键', message: `确定要删除外键 ${def.name} 吗？`, detail: '外键约束将被移除。',
      });
      if (response !== 1) return { ok: false, canceled: true };
      sql = `ALTER TABLE ${tbl} DROP FOREIGN KEY ${ident(def.name)}`;
    } else throw new Error('未知操作');
    await conn.query(sql);
    return { ok: true, sql };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 整库结构快照（用于对比）
ipcMain.handle('db:schemaSnapshot', async (_e, { connId, database }) => {
  try { const w = await getConn(connId); return { ok: true, tables: await w.driver.schemaSnapshot(w.raw, database) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 危险操作：清空 / 删除（带原生确认框）
ipcMain.handle('db:dangerOp', async (_e, { connId, database, table, op }) => {
  const verb = op === 'truncate' ? '清空' : '删除';
  try {
    const w = await getConn(connId);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['取消', verb], defaultId: 0, cancelId: 0,
      title: `${verb}表`,
      message: `确定要${verb}表 ${database}.${table} 吗？`,
      detail: op === 'drop' ? '该表及其所有数据将被永久删除，此操作不可恢复！' : '表中所有数据将被清空，此操作不可恢复！',
    });
    if (response !== 1) return { ok: false, canceled: true };
    const q = w.driver.q;
    const sql = op === 'truncate' ? `TRUNCATE TABLE ${q(database)}.${q(table)}` : `DROP TABLE ${q(database)}.${q(table)}`;
    await w.driver.exec(w.raw, sql);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ====================== 数据编辑 ======================
// 全库列信息（用于自动补全）
ipcMain.handle('db:dbColumns', async (_e, { connId, database }) => {
  try { const w = await getConn(connId); return { ok: true, data: await w.driver.dbColumns(w.raw, database) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 更新单个单元格
ipcMain.handle('db:update', async (_e, { connId, database, table, column, value, where }) => {
  try {
    const w = await getConn(connId);
    if (!Object.keys(where || {}).length) throw new Error('缺少定位条件（该表无主键，无法安全更新）');
    const n = await w.driver.updateCell(w.raw, { db: database, table, column, value, where });
    return { ok: true, affectedRows: n };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 插入新行
ipcMain.handle('db:insert', async (_e, { connId, database, table, values }) => {
  try {
    const w = await getConn(connId);
    if (!Object.keys(values || {}).length) throw new Error('没有要插入的字段');
    const r = await w.driver.insert(w.raw, { db: database, table, values });
    return { ok: true, insertId: r.insertId, affectedRows: r.affectedRows };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 删除选中行（带原生确认）
ipcMain.handle('db:delete', async (_e, { connId, database, table, wheres }) => {
  try {
    if (!wheres || !wheres.length) return { ok: false, error: '没有选中行' };
    const w = await getConn(connId);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0,
      title: '删除行', message: `确定要从 ${database}.${table} 删除选中的 ${wheres.length} 行吗？`,
      detail: '此操作不可恢复！',
    });
    if (response !== 1) return { ok: false, canceled: true };
    const affected = await w.driver.del(w.raw, { db: database, table, wheres });
    return { ok: true, affectedRows: affected };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ====================== SQL Dump 导出（MySQL/MariaDB）======================
ipcMain.handle('db:dump', async (_e, { connId, database, tables, structure = true, data = true, drop = true }) => {
  try {
    const w = await getConn(connId);
    if (!w.driver.caps.dump) throw new Error('该数据库类型暂不支持 SQL 导出');
    const conn = w.raw;
    let list = tables;
    if (!list || !list.length) {
      const [tr] = await conn.query(
        `SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [database]);
      list = tr.map((r) => r.n);
    }
    let out = `-- MySQL dump · 由 MySQL客户端 导出\n-- 数据库: ${database}\n-- 导出时间: ${new Date().toLocaleString()}\n`;
    out += `-- 表数量: ${list.length}\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`;

    for (const table of list) {
      out += `-- ----------------------------\n-- 表结构 / 数据: ${table}\n-- ----------------------------\n`;
      if (drop) out += `DROP TABLE IF EXISTS ${ident(table)};\n`;
      if (structure) {
        const [cr] = await conn.query(`SHOW CREATE TABLE ${ident(database)}.${ident(table)}`);
        out += (cr[0]['Create Table'] || cr[0]['Create View']) + ';\n\n';
      }
      if (data) {
        const [rows, fields] = await conn.query(`SELECT * FROM ${ident(database)}.${ident(table)}`);
        if (rows.length) {
          const cols = fields.map((f) => f.name);
          const colList = cols.map(ident).join(', ');
          const CHUNK = 500;
          for (let i = 0; i < rows.length; i += CHUNK) {
            const vals = rows.slice(i, i + CHUNK)
              .map((r) => '(' + cols.map((c) => sqlEscape(r[c])).join(', ') + ')').join(',\n');
            out += `INSERT INTO ${ident(table)} (${colList}) VALUES\n${vals};\n`;
          }
          out += '\n';
        }
      }
    }
    out += 'SET FOREIGN_KEY_CHECKS = 1;\n';

    const defaultName = (list.length === 1 ? list[0] : database) + '.sql';
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName, filters: [{ name: 'SQL', extensions: ['sql'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, out, 'utf-8');
    return { ok: true, filePath, tableCount: list.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ====================== 数据导入 ======================
function parseCSV(text) {
  const rows = []; let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => !(r.length === 1 && r[0] === '')).map((r) => {
    const o = {}; header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : null; }); return o;
  });
}
function parseImportFile(filePath, format) {
  const ext = path.extname(filePath).toLowerCase();
  const fmt = (format && format !== 'auto') ? format
    : ext === '.json' ? 'json' : (ext === '.xlsx' || ext === '.xls') ? 'excel' : ext === '.sql' ? 'sql' : 'csv';
  if (fmt === 'sql') return { format: 'sql', sql: fs.readFileSync(filePath, 'utf-8') };
  let rows = [];
  if (fmt === 'json') { const d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); rows = Array.isArray(d) ? d : [d]; }
  else if (fmt === 'excel') {
    if (!xlsx) throw new Error('未安装 Excel 解析库 (xlsx)');
    const wb = xlsx.readFile(filePath); const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: false });
  } else rows = parseCSV(fs.readFileSync(filePath, 'utf-8'));
  const cols = [], seen = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } }));
  return { format: fmt, columns: cols, rows };
}
let importCache = null;

ipcMain.handle('dialog:openFile', async (_e, { filters, title } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title, properties: ['openFile'], filters: filters || [] });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: filePaths[0] };
});

ipcMain.handle('db:importPreview', async (_e, { filePath, format }) => {
  try {
    const parsed = parseImportFile(filePath, format);
    importCache = { filePath, parsed };
    if (parsed.format === 'sql') return { ok: true, format: 'sql', length: parsed.sql.length };
    return { ok: true, format: parsed.format, columns: parsed.columns, total: parsed.rows.length, sample: parsed.rows.slice(0, 5) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db:import', async (e, { connId, database, table, format, filePath, mapping, mode }) => {
  try {
    const w = await getConn(connId);
    const parsed = (importCache && importCache.filePath === filePath) ? importCache.parsed : parseImportFile(filePath, format);
    if (parsed.format === 'sql') { await w.driver.exec(w.raw, parsed.sql); return { ok: true, executed: true }; }
    const srcRows = parsed.rows;
    if (!srcRows.length) return { ok: false, error: '没有可导入的数据行' };
    const maps = (mapping || []).filter((m) => m.source);
    if (!maps.length) return { ok: false, error: '请至少映射一个字段' };
    const targetCols = maps.map((m) => m.target);
    let conflictCols = [];
    try { const cols = await w.driver.columns(w.raw, database, table); conflictCols = cols.filter((c) => c.key === 'PRI').map((c) => c.name); } catch (_) {}
    const sql = w.driver.importSql({ db: database, table, columns: targetCols, mode, conflictCols });

    await w.driver.begin(w.raw);
    let inserted = 0;
    try {
      for (let i = 0; i < srcRows.length; i++) {
        const r = srcRows[i];
        const params = maps.map((m) => { const v = r[m.source]; return v === undefined || v === '' ? null : v; });
        await w.driver.run(w.raw, sql, params);
        inserted++;
        if (i % 50 === 0 && mainWindow) mainWindow.webContents.send('import:progress', { done: i + 1, total: srcRows.length });
      }
      await w.driver.commit(w.raw);
    } catch (err) {
      try { await w.driver.rollback(w.raw); } catch (_) {}
      return { ok: false, error: `第 ${inserted + 1} 行导入失败：${err.message}（已回滚，未写入任何数据）` };
    }
    if (mainWindow) mainWindow.webContents.send('import:progress', { done: srcRows.length, total: srcRows.length });
    return { ok: true, inserted, total: srcRows.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ====================== 导出 / 剪贴板 ======================
ipcMain.handle('export:save', async (_e, { defaultName, content, format }) => {
  try {
    const filters = format === 'json'
      ? [{ name: 'JSON', extensions: ['json'] }]
      : format === 'sql'
        ? [{ name: 'SQL', extensions: ['sql'] }]
        : [{ name: 'CSV', extensions: ['csv'] }];
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName, filters });
    if (canceled || !filePath) return { ok: false, canceled: true };
    // CSV 加 UTF-8 BOM，避免 Excel 中文乱码
    const data = format === 'csv' ? '﻿' + content : content;
    fs.writeFileSync(filePath, data, 'utf-8');
    return { ok: true, filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });

// ====================== SQL 历史 ======================
ipcMain.handle('history:list', () => readJson(HISTORY_FILE, []));

ipcMain.handle('history:add', (_e, entry) => {
  let list = readJson(HISTORY_FILE, []);
  const sql = (entry.sql || '').trim();
  if (!sql) return list;
  list = list.filter((h) => h.sql !== sql);              // 去重，最近的置顶
  list.unshift({ sql, at: entry.at || 0, conn: entry.conn || '' });
  if (list.length > 200) list = list.slice(0, 200);
  writeJson(HISTORY_FILE, list);
  return list;
});

ipcMain.handle('history:clear', () => { writeJson(HISTORY_FILE, []); return []; });
