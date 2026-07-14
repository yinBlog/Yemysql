// 数据库驱动抽象层：为不同数据库类型提供统一接口
const fs = require('fs');
const mysql = require('mysql2/promise');
let pg = null;
try { pg = require('pg'); } catch (_) { /* 未安装 pg 时 PostgreSQL 不可用 */ }
if (pg && pg.types) {
  // 让日期/时间类型返回字符串，便于表格直接展示
  [1082, 1083, 1114, 1184, 1266].forEach((oid) => { try { pg.types.setTypeParser(oid, (v) => v); } catch (_) {} });
}

const qMysql = (n) => '`' + String(n).replace(/`/g, '``') + '`';
const qPg = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// ---------------- MySQL / MariaDB ----------------
function mysqlDriver(type) {
  const q = qMysql;
  return {
    type, q,
    caps: { alter: true, dump: true, fk: true, index: true, ddlNative: true },
    defaultPort: 3306,
    async connect(cfg) {
      const c = {
        host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 3306,
        user: cfg.user || 'root', password: cfg.password || '', database: cfg.database || undefined,
        multipleStatements: true, dateStrings: true, connectTimeout: 10000,
      };
      if (cfg.ssl) c.ssl = { rejectUnauthorized: false };
      return await mysql.createConnection(c);
    },
    async end(c) { await c.end(); },
    async version(c) { const [r] = await c.query('SELECT VERSION() v'); return r[0].v; },
    async useDatabase(c, db) { await c.query('USE ' + q(db)); },
    async databases(c) { const [r] = await c.query('SHOW DATABASES'); return r.map((x) => Object.values(x)[0]); },
    async tables(c, db) {
      const [r] = await c.query(
        `SELECT TABLE_NAME as name, TABLE_TYPE as type, TABLE_ROWS as \`rows\`, TABLE_COMMENT as comment
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
      return r;
    },
    async columns(c, db, table) {
      const [r] = await c.query(
        `SELECT COLUMN_NAME as name, COLUMN_TYPE as type, IS_NULLABLE as nullable,
                COLUMN_KEY as \`key\`, COLUMN_DEFAULT as \`default\`, EXTRA as extra, COLUMN_COMMENT as comment
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
      return r;
    },
    async indexesRaw(c, db, table) { const [r] = await c.query(`SHOW INDEX FROM ${q(db)}.${q(table)}`); return r; },
    async query(c, sql) {
      const [res, fields] = await c.query(sql);
      if (Array.isArray(res) && fields) {
        if (res.length > 0 && typeof res[0] === 'object' && !('affectedRows' in res[0])) return { kind: 'select', columns: fields.map((f) => f.name), rows: res };
        if (res.length === 0) return { kind: 'select', columns: fields.map((f) => f.name), rows: [] };
      }
      const info = Array.isArray(res) ? res[res.length - 1] : res;
      return { kind: 'modify', affectedRows: info.affectedRows, insertId: info.insertId };
    },
    async browse(c, { db, table, limit, offset, orderBy, orderDir, where }) {
      const tbl = `${q(db)}.${q(table)}`;
      const w = where && where.trim() ? ' WHERE ' + where : '';
      const o = orderBy ? ` ORDER BY ${q(orderBy)} ${orderDir === 'desc' ? 'DESC' : 'ASC'}` : '';
      const [rows, fields] = await c.query(`SELECT * FROM ${tbl}${w}${o} LIMIT ? OFFSET ?`, [Number(limit), Number(offset)]);
      const [cnt] = await c.query(`SELECT COUNT(*) c FROM ${tbl}${w}`);
      return { columns: fields ? fields.map((f) => f.name) : (rows[0] ? Object.keys(rows[0]) : []), rows, total: cnt[0].c };
    },
    async ddl(c, db, table) { const [r] = await c.query(`SHOW CREATE TABLE ${q(db)}.${q(table)}`); return r[0]['Create Table'] || r[0]['Create View']; },
    async updateCell(c, { db, table, column, value, where }) {
      const wc = Object.keys(where);
      const sql = `UPDATE ${q(db)}.${q(table)} SET ${q(column)} = ? WHERE ` + wc.map((k) => `${q(k)} <=> ?`).join(' AND ');
      const [r] = await c.query(sql, [value, ...wc.map((k) => where[k])]); return r.affectedRows;
    },
    async insert(c, { db, table, values }) {
      const cols = Object.keys(values);
      const sql = `INSERT INTO ${q(db)}.${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      const [r] = await c.query(sql, cols.map((k) => values[k])); return { affectedRows: r.affectedRows, insertId: r.insertId };
    },
    async del(c, { db, table, wheres }) {
      let n = 0;
      for (const w of wheres) {
        const wc = Object.keys(w);
        const [r] = await c.query(`DELETE FROM ${q(db)}.${q(table)} WHERE ` + wc.map((k) => `${q(k)} <=> ?`).join(' AND '), wc.map((k) => w[k]));
        n += r.affectedRows;
      }
      return n;
    },
    async dbColumns(c, db) {
      const [r] = await c.query(`SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE type, COLUMN_KEY keyc FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
      return r.map((x) => ({ t: x.t, c: x.c, type: x.type, key: x.keyc }));
    },
    async schemaSnapshot(c, db) {
      const [rows] = await c.query(
        `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE type, IS_NULLABLE nullable, COLUMN_KEY keyc, COLUMN_DEFAULT def, EXTRA extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
      const t = {};
      for (const r of rows) { (t[r.t] = t[r.t] || []).push({ name: r.c, type: r.type, nullable: r.nullable, key: r.keyc, default: r.def, extra: r.extra }); }
      return t;
    },
    async exec(c, sql) { await c.query(sql); },
    async begin(c) { await c.beginTransaction(); },
    async commit(c) { await c.commit(); },
    async rollback(c) { await c.rollback(); },
    async run(c, sql, params) { const [r] = await c.query(sql, params); return r.affectedRows; },
    importSql({ db, table, columns, mode }) {
      const cols = columns.map(q).join(', ');
      const ph = columns.map(() => '?').join(', ');
      const head = mode === 'skip' ? 'INSERT IGNORE' : 'INSERT';
      let sql = `${head} INTO ${q(db)}.${q(table)} (${cols}) VALUES (${ph})`;
      if (mode === 'overwrite') sql += ' ON DUPLICATE KEY UPDATE ' + columns.map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ');
      return sql;
    },
  };
}

// ---------------- PostgreSQL ----------------
function pgDriver() {
  if (!pg) throw new Error('未安装 PostgreSQL 驱动 (pg)');
  const q = qPg;
  return {
    type: 'postgres', q,
    caps: { alter: false, dump: false, fk: false, index: false, ddlNative: false }, // 高级 DDL 暂仅 MySQL
    defaultPort: 5432,
    async connect(cfg) {
      const client = new pg.Client({
        host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 5432,
        user: cfg.user || 'postgres', password: cfg.password || '', database: cfg.database || 'postgres',
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10000,
      });
      await client.connect();
      return client;
    },
    async end(c) { await c.end(); },
    async version(c) { const r = await c.query('SELECT version() v'); return r.rows[0].v; },
    async useDatabase(c, db) { await c.query('SET search_path TO ' + q(db)); }, // pg：库内 schema
    async databases(c) {
      const r = await c.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY schema_name`);
      return r.rows.map((x) => x.schema_name);
    },
    async tables(c, schema) {
      const r = await c.query(`SELECT table_name as name, table_type as type, NULL as "rows", '' as comment FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema]);
      return r.rows;
    },
    async columns(c, schema, table) {
      const r = await c.query(
        `SELECT column_name as name,
                CASE WHEN character_maximum_length IS NOT NULL THEN data_type||'('||character_maximum_length||')' ELSE data_type END as type,
                is_nullable as nullable, '' as key, column_default as "default", '' as extra, '' as comment
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]);
      let pkset = new Set();
      try {
        const pk = await c.query(
          `SELECT a.attname FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`, [schema, table]);
        pkset = new Set(pk.rows.map((x) => x.attname));
      } catch (_) {}
      return r.rows.map((col) => ({ ...col, key: pkset.has(col.name) ? 'PRI' : '' }));
    },
    async indexesRaw(c, schema, table) {
      const r = await c.query(
        `SELECT i.relname as "Key_name", (NOT ix.indisunique) as nonuniq, a.attname as "Column_name",
                (1 + array_position(ix.indkey, a.attnum)) as "Seq_in_index", am.amname as "Index_type"
         FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_am am ON am.oid = i.relam
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE n.nspname = $1 AND t.relname = $2 ORDER BY i.relname, "Seq_in_index"`, [schema, table]);
      return r.rows.map((x) => ({ Key_name: x.Key_name, Non_unique: x.nonuniq ? 1 : 0, Column_name: x.Column_name, Seq_in_index: x.Seq_in_index, Index_type: x.Index_type }));
    },
    async query(c, sql) {
      const res = await c.query(sql);
      const r = Array.isArray(res) ? res[res.length - 1] : res;
      if (r.command === 'SELECT' || (r.fields && r.fields.length)) return { kind: 'select', columns: (r.fields || []).map((f) => f.name), rows: r.rows || [] };
      return { kind: 'modify', affectedRows: r.rowCount, insertId: undefined };
    },
    async browse(c, { db, table, limit, offset, orderBy, orderDir, where }) {
      const tbl = `${q(db)}.${q(table)}`;
      const w = where && where.trim() ? ' WHERE ' + where : '';
      const o = orderBy ? ` ORDER BY ${q(orderBy)} ${orderDir === 'desc' ? 'DESC' : 'ASC'}` : '';
      const res = await c.query(`SELECT * FROM ${tbl}${w}${o} LIMIT $1 OFFSET $2`, [Number(limit), Number(offset)]);
      const cnt = await c.query(`SELECT COUNT(*)::int c FROM ${tbl}${w}`);
      return { columns: res.fields.map((f) => f.name), rows: res.rows, total: cnt.rows[0].c };
    },
    async ddl(c, schema, table) {
      const cols = await this.columns(c, schema, table);
      const lines = cols.map((col) => {
        let s = `  ${q(col.name)} ${col.type}`;
        if (col.nullable === 'NO') s += ' NOT NULL';
        if (col.default != null) s += ' DEFAULT ' + col.default;
        return s;
      });
      const pk = cols.filter((col) => col.key === 'PRI').map((col) => q(col.name));
      if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
      return `CREATE TABLE ${q(schema)}.${q(table)} (\n${lines.join(',\n')}\n)`;
    },
    async updateCell(c, { db, table, column, value, where }) {
      const wc = Object.keys(where);
      const sql = `UPDATE ${q(db)}.${q(table)} SET ${q(column)} = $1 WHERE ` + wc.map((k, i) => `${q(k)} IS NOT DISTINCT FROM $${i + 2}`).join(' AND ');
      const r = await c.query(sql, [value, ...wc.map((k) => where[k])]); return r.rowCount;
    },
    async insert(c, { db, table, values }) {
      const cols = Object.keys(values);
      const sql = `INSERT INTO ${q(db)}.${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`;
      const r = await c.query(sql, cols.map((k) => values[k])); return { affectedRows: r.rowCount };
    },
    async del(c, { db, table, wheres }) {
      let n = 0;
      for (const w of wheres) {
        const wc = Object.keys(w);
        const sql = `DELETE FROM ${q(db)}.${q(table)} WHERE ` + wc.map((k, i) => `${q(k)} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ');
        const r = await c.query(sql, wc.map((k) => w[k])); n += r.rowCount;
      }
      return n;
    },
    async dbColumns(c, schema) {
      const r = await c.query(
        `SELECT table_name t, column_name c,
                CASE WHEN character_maximum_length IS NOT NULL THEN data_type||'('||character_maximum_length||')' ELSE data_type END type
         FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [schema]);
      return r.rows.map((x) => ({ t: x.t, c: x.c, type: x.type, key: '' }));
    },
    async schemaSnapshot(c, schema) {
      const r = await c.query(
        `SELECT table_name t, column_name c,
                CASE WHEN character_maximum_length IS NOT NULL THEN data_type||'('||character_maximum_length||')' ELSE data_type END type,
                is_nullable nullable, column_default def
         FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [schema]);
      const t = {};
      for (const row of r.rows) { (t[row.t] = t[row.t] || []).push({ name: row.c, type: row.type, nullable: row.nullable, key: '', default: row.def, extra: '' }); }
      return t;
    },
    async exec(c, sql) { await c.query(sql); },
    async begin(c) { await c.query('BEGIN'); },
    async commit(c) { await c.query('COMMIT'); },
    async rollback(c) { await c.query('ROLLBACK'); },
    async run(c, sql, params) { const r = await c.query(sql, params); return r.rowCount; },
    importSql({ db, table, columns, mode, conflictCols }) {
      const cols = columns.map(q).join(', ');
      const ph = columns.map((_, i) => '$' + (i + 1)).join(', ');
      let sql = `INSERT INTO ${q(db)}.${q(table)} (${cols}) VALUES (${ph})`;
      if (mode === 'skip') sql += ' ON CONFLICT DO NOTHING';
      else if (mode === 'overwrite') {
        const upd = columns.filter((c) => !(conflictCols || []).includes(c));
        if (conflictCols && conflictCols.length && upd.length) {
          sql += ` ON CONFLICT (${conflictCols.map(q).join(', ')}) DO UPDATE SET ` + upd.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');
        } else sql += ' ON CONFLICT DO NOTHING';
      }
      return sql;
    },
  };
}

// ---------------- SQLite (sql.js / 纯 JS) ----------------
let SQLEngine = null;
let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch (_) {}
async function ensureSqlJs() {
  if (!initSqlJs) throw new Error('未安装 SQLite 驱动 (sql.js)');
  if (!SQLEngine) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQLEngine = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  }
  return SQLEngine;
}
function sqliteDriver() {
  const q = qPg; // SQLite 用双引号引用标识符
  const persist = (raw) => { if (raw.file) fs.writeFileSync(raw.file, Buffer.from(raw.db.export())); };
  const toRows = (rs) => rs.values.map((v) => Object.fromEntries(rs.columns.map((c, i) => [c, v[i]])));
  return {
    type: 'sqlite', q,
    caps: { alter: false, dump: false, fk: false, index: false, ddlNative: true },
    defaultPort: 0,
    needsFile: true,
    async connect(cfg) {
      const SQL = await ensureSqlJs();
      const file = cfg.database || cfg.file || '';
      let data = null;
      if (file && fs.existsSync(file)) data = fs.readFileSync(file);
      const db = new SQL.Database(data);
      return { db, file };
    },
    async end(raw) { try { raw.db.close(); } catch (_) {} },
    async version() { const SQL = await ensureSqlJs(); const d = new SQL.Database(); const r = d.exec('SELECT sqlite_version()'); d.close(); return 'SQLite ' + (r[0] ? r[0].values[0][0] : ''); },
    async useDatabase() { /* 单库，无操作 */ },
    async databases() { return ['main']; },
    async tables(raw) {
      const r = raw.db.exec(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
      if (!r.length) return [];
      return toRows(r[0]).map((x) => ({ name: x.name, type: x.type, rows: null, comment: '' }));
    },
    async columns(raw, db, table) {
      const r = raw.db.exec(`PRAGMA table_info(${q(table)})`);
      if (!r.length) return [];
      return toRows(r[0]).map((x) => ({ name: x.name, type: x.type, nullable: x.notnull ? 'NO' : 'YES', key: x.pk ? 'PRI' : '', default: x.dflt_value, extra: '', comment: '' }));
    },
    async indexesRaw(raw, db, table) {
      const list = raw.db.exec(`PRAGMA index_list(${q(table)})`);
      if (!list.length) return [];
      const out = [];
      for (const ix of toRows(list[0])) {
        const info = raw.db.exec(`PRAGMA index_info(${q(ix.name)})`);
        const colRows = info.length ? toRows(info[0]) : [];
        colRows.forEach((cr, i) => out.push({ Key_name: ix.name, Non_unique: ix.unique ? 0 : 1, Column_name: cr.name, Seq_in_index: i + 1, Index_type: 'BTREE' }));
      }
      return out;
    },
    async query(raw, sql) {
      const rs = raw.db.exec(sql);
      if (rs.length && rs[rs.length - 1].columns) { const last = rs[rs.length - 1]; return { kind: 'select', columns: last.columns, rows: toRows(last) }; }
      const affected = raw.db.getRowsModified();
      persist(raw);
      return { kind: 'modify', affectedRows: affected };
    },
    async browse(raw, { table, limit, offset, orderBy, orderDir, where }) {
      const tbl = q(table);
      const w = where && where.trim() ? ' WHERE ' + where : '';
      const o = orderBy ? ` ORDER BY ${q(orderBy)} ${orderDir === 'desc' ? 'DESC' : 'ASC'}` : '';
      const rs = raw.db.exec(`SELECT * FROM ${tbl}${w}${o} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`);
      const cnt = raw.db.exec(`SELECT COUNT(*) FROM ${tbl}${w}`);
      const total = cnt.length ? cnt[0].values[0][0] : 0;
      if (!rs.length) return { columns: [], rows: [], total };
      return { columns: rs[0].columns, rows: toRows(rs[0]), total };
    },
    async ddl(raw, db, table) {
      const r = raw.db.exec(`SELECT sql FROM sqlite_master WHERE name = ${sqlStr(table)} AND type IN ('table','view')`);
      return r.length ? r[0].values[0][0] : '';
    },
    async updateCell(raw, { table, column, value, where }) {
      const wc = Object.keys(where);
      const sql = `UPDATE ${q(table)} SET ${q(column)} = ? WHERE ` + wc.map((k) => `${q(k)} IS ?`).join(' AND ');
      raw.db.run(sql, [value, ...wc.map((k) => where[k])]); const n = raw.db.getRowsModified(); persist(raw); return n;
    },
    async insert(raw, { table, values }) {
      const cols = Object.keys(values);
      const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      raw.db.run(sql, cols.map((k) => values[k])); persist(raw); return { affectedRows: raw.db.getRowsModified() };
    },
    async del(raw, { table, wheres }) {
      let n = 0;
      for (const w of wheres) { const wc = Object.keys(w); raw.db.run(`DELETE FROM ${q(table)} WHERE ` + wc.map((k) => `${q(k)} IS ?`).join(' AND '), wc.map((k) => w[k])); n += raw.db.getRowsModified(); }
      persist(raw); return n;
    },
    async dbColumns(raw) {
      const tbls = await this.tables(raw);
      const out = [];
      for (const t of tbls) { const cs = await this.columns(raw, 'main', t.name); cs.forEach((c) => out.push({ t: t.name, c: c.name, type: c.type, key: c.key })); }
      return out;
    },
    async schemaSnapshot(raw) {
      const tbls = await this.tables(raw); const out = {};
      for (const t of tbls) { out[t.name] = (await this.columns(raw, 'main', t.name)).map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, key: c.key, default: c.default, extra: '' })); }
      return out;
    },
    async exec(raw, sql) { raw.db.exec(sql); persist(raw); },
    async begin(raw) { raw.db.exec('BEGIN'); },
    async commit(raw) { raw.db.exec('COMMIT'); persist(raw); },
    async rollback(raw) { raw.db.exec('ROLLBACK'); },
    async run(raw, sql, params) { raw.db.run(sql, params); return raw.db.getRowsModified(); },
    importSql({ table, columns, mode }) {
      const cols = columns.map(q).join(', ');
      const ph = columns.map(() => '?').join(', ');
      const head = mode === 'skip' ? 'INSERT OR IGNORE' : mode === 'overwrite' ? 'INSERT OR REPLACE' : 'INSERT';
      return `${head} INTO ${q(table)} (${cols}) VALUES (${ph})`;
    },
  };
}
function sqlStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function createDriver(type) {
  if (type === 'postgres' || type === 'postgresql') return pgDriver();
  if (type === 'sqlite') return sqliteDriver();
  return mysqlDriver(type === 'mariadb' ? 'mariadb' : 'mysql');
}

module.exports = { createDriver, pgAvailable: !!pg, sqliteAvailable: !!initSqlJs };
