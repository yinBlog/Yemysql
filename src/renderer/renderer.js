const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ====================== 状态 ======================
const state = {
  connections: [],
  activeConn: null,
  tree: new Map(),
  active: { conn: null, db: null, table: null },
  data: { db: null, table: null, offset: 0, limit: 200, total: 0, sortCol: null, sortDir: 'asc', where: '', pk: [], colMeta: [] },
  struct: { db: null, table: null, cols: [] },
  import: null,
  queryTabs: [],
  activeQTab: null,
};
let qtabSeq = 0;

// ====================== 工具 ======================
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast ' + kind;
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}
function setStatus(msg) { $('#sb-msg').textContent = msg || ''; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escAttr = escapeHtml;
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ====================== 结果视图 ======================
const RENDER_CAP = 5000;
let activePvResize = null; // 预览面板宽度拖拽中的目标

class ResultView {
  constructor(host, opts = {}) {
    this.host = host;
    this.onSort = opts.onSort || null;
    this.name = opts.name || 'result';
    this.columns = []; this.rows = [];
    this.sortCol = null; this.sortDir = 'asc';
    this.filter = '';
    this.editable = false; this.pk = [];
    this.onCommitCell = opts.onCommitCell || null;
    this.selected = new Set();
    this.preview = !!opts.preview;   // 是否启用行预览面板
    this.previewRow = null;
    this.previewWidth = Number(localStorage.getItem('previewWidth')) || 340;
    this.pager = null;               // { offset, pageSize, total, onPage } —— 结果翻页
    this.fetchAll = opts.fetchAll || null; // async () => {columns, rows} —— 导出全部数据（忽略分页/过滤）
  }
  setMessage(html, cls = '') { this.host.innerHTML = `<div class="result-msg ${cls}">${html}</div>`; }

  setData(columns, rows, meta = {}) {
    this.columns = columns || []; this.rows = rows || [];
    this.filter = ''; this.selected = new Set(); this.previewRow = null;
    if (this.onSort) { this.sortCol = meta.sortCol || null; this.sortDir = meta.sortDir || 'asc'; }
    else { this.sortCol = null; this.sortDir = 'asc'; }
    this.render();
  }
  getSelected() { return [...this.selected]; }

  displayRows() {
    let rows = this.rows;
    if (this.filter) {
      const f = this.filter.toLowerCase();
      rows = rows.filter((r) => this.columns.some((c) => {
        const v = r[c]; return v !== null && v !== undefined && String(v).toLowerCase().includes(f);
      }));
    }
    if (!this.onSort && this.sortCol) {
      const c = this.sortCol, dir = this.sortDir === 'asc' ? 1 : -1;
      rows = rows.slice().sort((a, b) => {
        let x = a[c], y = b[c];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const nx = Number(x), ny = Number(y);
        if (!isNaN(nx) && !isNaN(ny) && x !== '' && y !== '') return (nx - ny) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
    }
    return rows;
  }

  render() {
    if (!this.columns.length) { this.setMessage('（无结果集）'); return; }
    const all = this.displayRows();
    const rows = all.slice(0, RENDER_CAP);
    const sortMark = (c) => this.sortCol === c ? `<span class="sort">${this.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
    const thead = '<thead><tr><th class="rownum">#</th>' +
      this.columns.map((c) => `<th data-col="${escAttr(c)}">${escapeHtml(c)}${sortMark(c)}</th>`).join('') + '</tr></thead>';
    const ec = this.editable ? ' editable' : '';
    const body = rows.map((row, i) => {
      const selCls = this.selected.has(row) ? ' row-sel' : '';
      const tds = this.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return `<td class="null${ec}" data-col="${escAttr(c)}">NULL</td>`;
        const s = String(v);
        return `<td class="${this.editable ? 'editable' : ''}" data-col="${escAttr(c)}" title="${escAttr(s)}">${escapeHtml(s)}</td>`;
      }).join('');
      const rn = `<td class="rownum${this.editable ? ' selectable' : ''}">${i + 1}</td>`;
      return `<tr data-i="${i}" class="${selCls.trim()}">${rn}${tds}</tr>`;
    }).join('');
    const capped = all.length > RENDER_CAP ? `（仅显示前 ${RENDER_CAP} 行）` : '';
    const exportLabel = this.fetchAll ? '（全部）' : '';
    let pagerHtml = '';
    if (this.pager) {
      const { offset, pageSize, total } = this.pager;
      const from = total === 0 ? 0 : offset + 1, to = Math.min(offset + pageSize, total);
      pagerHtml = `<span class="rt-pager">
        <button class="btn sm" data-pg="first" ${offset <= 0 ? 'disabled' : ''} title="首页">«</button>
        <button class="btn sm" data-pg="prev" ${offset <= 0 ? 'disabled' : ''}>‹ 上一页</button>
        <span class="pg-info">${from}–${to} / ${total}</span>
        <button class="btn sm" data-pg="next" ${offset + pageSize >= total ? 'disabled' : ''}>下一页 ›</button>
        <button class="btn sm" data-pg="last" ${offset + pageSize >= total ? 'disabled' : ''} title="末页">»</button>
      </span>`;
    }
    const info = this.pager ? `本页 ${all.length} 行` : `${all.length} / ${this.rows.length} 行 ${capped}`;
    this.host.innerHTML = `
      <div class="result-toolbar">
        <input class="filter" placeholder="过滤当前结果…" value="${escAttr(this.filter)}" />
        <button class="btn sm" data-act="copy">复制${exportLabel}</button>
        <button class="btn sm" data-act="csv">导出 CSV${exportLabel}</button>
        <button class="btn sm" data-act="json">导出 JSON${exportLabel}</button>
        <button class="btn sm" data-act="chart">📊 图表</button>
        <button class="btn sm ${this.preview ? 'primary' : ''}" data-act="preview">👁 预览</button>
        <span class="rt-info">${info}</span>
        ${pagerHtml}
      </div>
      <div class="result-main">
        <div class="grid-wrap"><table class="grid">${thead}<tbody>${body}</tbody></table></div>
        ${this.preview ? `<div class="pv-resizer"></div><div class="preview-pane" style="width:${this.previewWidth}px">${this.renderPreview()}</div>` : ''}
      </div>`;
    this._displayed = rows;
    this.bind();
  }

  renderPreview() {
    const head = `<div class="pv-head"><span>行预览</span><div class="pv-actions">
      <button class="btn sm" data-pv="json" title="复制为 JSON">JSON</button>
      <button class="btn sm" data-pv="close" title="关闭预览">×</button></div></div>`;
    if (!this.previewRow) return head + '<div class="pv-empty">点击左侧任意行，查看该行完整内容</div>';
    const r = this.previewRow;
    const body = this.columns.map((c) => {
      const v = r[c], isNull = v === null || v === undefined;
      return `<div class="rd-row"><div class="rd-k">${escapeHtml(c)}</div><div class="rd-v ${isNull ? 'null' : ''}">${isNull ? 'NULL' : escapeHtml(String(v))}</div></div>`;
    }).join('');
    return head + `<div class="pv-body">${body}</div>`;
  }

  showPreview(row) {
    this.previewRow = row;
    const pane = this.host.querySelector('.preview-pane');
    if (!pane) return;
    pane.innerHTML = this.renderPreview();
    this.host.querySelectorAll('tr.row-preview').forEach((t) => t.classList.remove('row-preview'));
    const idx = this._displayed.indexOf(row);
    const tr = this.host.querySelector(`tbody tr[data-i="${idx}"]`);
    if (tr) tr.classList.add('row-preview');
    this.bindPreviewButtons();
  }

  bindPreviewButtons() {
    const pane = this.host.querySelector('.preview-pane');
    if (!pane) return;
    const close = pane.querySelector('[data-pv="close"]');
    if (close) close.onclick = () => { this.preview = false; this.previewRow = null; this.render(); };
    const json = pane.querySelector('[data-pv="json"]');
    if (json) json.onclick = async () => {
      if (!this.previewRow) { toast('请先点击一行', 'err'); return; }
      await window.api.copy(JSON.stringify(this.previewRow, null, 2)); toast('已复制该行 JSON', 'ok');
    };
  }

  bind() {
    const fEl = this.host.querySelector('.filter');
    if (fEl) fEl.oninput = (e) => {
      this.filter = e.target.value; const pos = e.target.selectionStart; this.render();
      const nf = this.host.querySelector('.filter'); if (nf) { nf.focus(); nf.setSelectionRange(pos, pos); }
    };
    this.host.querySelectorAll('.result-toolbar [data-act]').forEach((b) => b.onclick = () => this.action(b.dataset.act));
    if (this.pager) this.host.querySelectorAll('.rt-pager [data-pg]').forEach((b) => b.onclick = () => {
      if (b.disabled) return;
      const { offset, pageSize, total } = this.pager;
      const last = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
      const to = { first: 0, prev: offset - pageSize, next: offset + pageSize, last }[b.dataset.pg];
      this.pager.onPage(Math.max(0, Math.min(to, last)));
    });

    this.host.querySelectorAll('th[data-col]').forEach((th) => {
      th.onclick = () => {
        const c = th.dataset.col;
        if (this.sortCol === c) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        else { this.sortCol = c; this.sortDir = 'asc'; }
        if (this.onSort) this.onSort(this.sortCol, this.sortDir); else this.render();
      };
    });

    // 单元格点击：复制 + 行预览
    this.host.querySelectorAll('tbody td:not(.rownum)').forEach((td) => {
      td.onclick = async () => {
        this.host.querySelectorAll('td.sel').forEach((x) => x.classList.remove('sel'));
        td.classList.add('sel');
        if (this.preview) { const tr = td.parentElement; this.showPreview(this._displayed[Number(tr.dataset.i)]); }
        const txt = td.classList.contains('null') ? '' : (td.getAttribute('title') ?? td.textContent);
        await window.api.copy(txt); setStatus('已复制单元格');
      };
    });
    // 行号点击也触发预览（与编辑模式的选中并存）
    if (this.preview) this.host.querySelectorAll('tbody td.rownum').forEach((td) => {
      td.addEventListener('click', () => { const tr = td.parentElement; this.showPreview(this._displayed[Number(tr.dataset.i)]); });
    });
    if (this.preview) this.bindPreviewButtons();
    // 预览面板宽度拖拽
    const rz = this.host.querySelector('.pv-resizer');
    if (rz) rz.onmousedown = (e) => {
      e.preventDefault();
      activePvResize = { view: this, main: this.host.querySelector('.result-main'), pane: this.host.querySelector('.preview-pane') };
      document.body.style.cursor = 'col-resize';
    };

    if (this.editable) {
      this.host.querySelectorAll('tbody td.rownum').forEach((td) => {
        td.onclick = () => {
          const tr = td.parentElement, r = this._displayed[Number(tr.dataset.i)];
          if (this.selected.has(r)) this.selected.delete(r); else this.selected.add(r);
          tr.classList.toggle('row-sel');
        };
      });
      this.host.querySelectorAll('tbody td.editable').forEach((td) => {
        td.ondblclick = () => { const tr = td.parentElement; this.startEdit(td, this._displayed[Number(tr.dataset.i)], td.dataset.col); };
        td.oncontextmenu = (e) => { e.preventDefault(); const tr = td.parentElement; this.cellMenu(e, td, this._displayed[Number(tr.dataset.i)], td.dataset.col); };
      });
    } else {
      this.host.querySelectorAll('tbody tr').forEach((tr) => {
        tr.ondblclick = () => { const r = this._displayed[Number(tr.dataset.i)]; if (r) openRowDetail(this.columns, r); };
      });
    }
  }

  startEdit(td, row, col) {
    if (!td || !row) return;
    const cur = row[col];
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'cell-input';
    input.value = (cur === null || cur === undefined) ? '' : String(cur);
    td.innerHTML = ''; td.appendChild(input); input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      if (save && this.onCommitCell) await this.onCommitCell(row, col, input.value);
      this.render();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
  }

  cellMenu(e, td, row, col) {
    showMenu(e, [
      { label: '复制', action: async () => { await window.api.copy(row[col] === null || row[col] === undefined ? '' : String(row[col])); toast('已复制', 'ok'); } },
      { label: '编辑', action: () => this.startEdit(td, row, col) },
      { label: '设为 NULL', action: async () => { if (this.onCommitCell && await this.onCommitCell(row, col, null)) this.render(); } },
      { sep: true },
      { label: '查看行详情', action: () => openRowDetail(this.columns, row) },
    ]);
  }

  toTSV(cols = this.columns, rows = this.displayRows()) {
    return cols.join('\t') + '\n' + rows.map((r) => cols.map((c) => {
      const v = r[c]; return v === null || v === undefined ? '' : String(v).replace(/[\t\n]/g, ' ');
    }).join('\t')).join('\n');
  }
  toCSV(cols = this.columns, rows = this.displayRows()) {
    const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return cols.map(esc).join(',') + '\n' + rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
  }
  toJSON() { return JSON.stringify(this.displayRows(), null, 2); }

  async action(act) {
    if (act === 'preview') { this.preview = !this.preview; if (!this.preview) this.previewRow = null; this.render(); return; }
    if (!this.rows.length) { toast('没有可操作的数据', 'err'); return; }
    if (act === 'chart') { openChartModal(this.columns, this.displayRows()); return; }
    // 复制 / 导出：若有 fetchAll，则取完整结果集（全部数据，忽略分页与当前过滤）
    let cols = this.columns, rows = this.displayRows();
    if ((act === 'copy' || act === 'csv' || act === 'json') && this.fetchAll) {
      setStatus('正在读取全部数据用于导出…');
      const all = await this.fetchAll();
      setStatus('');
      if (!all) { toast('读取全部数据失败', 'err'); return; }
      cols = all.columns; rows = all.rows;
    }
    if (act === 'copy') { await window.api.copy(this.toTSV(cols, rows)); toast('已复制 ' + rows.length + ' 行', 'ok'); return; }
    const fmt = act === 'csv' ? 'csv' : 'json';
    const content = fmt === 'csv' ? this.toCSV(cols, rows) : JSON.stringify(rows, null, 2);
    const res = await window.api.exportFile({ defaultName: (this.name || 'export') + '_' + Date.now() + '.' + fmt, content, format: fmt });
    if (res.ok) toast(`已导出 ${rows.length} 行到 ` + res.filePath, 'ok'); else if (!res.canceled) toast('导出失败：' + res.error, 'err');
  }
}

const queryView = new ResultView($('#query-result'), { name: 'query' });
const structView = new ResultView($('#structure-content'), { name: 'structure' });
const dataView = new ResultView($('#data-result'), {
  name: 'data',
  preview: true,
  // 导出「数据」页时拉取符合当前 WHERE/排序的完整数据（非仅当前页）
  fetchAll: async () => {
    const d = state.data;
    if (!state.activeConn || !d.table) return null;
    const res = await window.api.browse({ connId: state.activeConn, database: d.db, table: d.table, limit: 100000000, offset: 0, orderBy: d.sortCol, orderDir: d.sortDir, where: d.where });
    return res.ok ? { columns: res.columns, rows: res.rows } : null;
  },
  onSort: (col, dir) => { state.data.sortCol = col; state.data.sortDir = dir; state.data.offset = 0; loadData(false); },
  onCommitCell: async (row, col, val) => {
    const d = state.data;
    if (!d.pk || !d.pk.length) { toast('该表无主键，不可编辑', 'err'); return false; }
    const where = {}; d.pk.forEach((k) => where[k] = row[k]);
    const res = await window.api.updateCell({ connId: state.activeConn, database: d.db, table: d.table, column: col, value: val, where });
    if (!res.ok) { toast('更新失败：' + res.error, 'err'); return false; }
    row[col] = val; toast('已更新', 'ok'); setStatus('已更新 ' + d.table + '.' + col); return true;
  },
});

// ====================== 行详情 ======================
function openRowDetail(columns, row) {
  $('#row-detail').innerHTML = columns.map((c) => {
    const v = row[c], isNull = v === null || v === undefined;
    return `<div class="rd-row"><div class="rd-k">${escapeHtml(c)}</div><div class="rd-v ${isNull ? 'null' : ''}">${isNull ? 'NULL' : escapeHtml(String(v))}</div></div>`;
  }).join('');
  $('#row-modal').classList.remove('hidden');
}

// ====================== 侧边栏树 ======================
function treeState(connId) {
  if (!state.tree.has(connId)) state.tree.set(connId, { expanded: false, connected: false, version: '', dbs: new Map() });
  return state.tree.get(connId);
}
const collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]'));
function persistCollapsed() { localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups])); }

function renderConnNode(root, c) {
  const ts = treeState(c.id);
  const conn = document.createElement('div');
  conn.className = 'node lvl-conn' + (state.activeConn === c.id ? ' active' : '') + (ts.connected ? ' connected' : '');
  conn.innerHTML = `<span class="twisty">${ts.expanded ? '▾' : '▸'}</span><span class="dot"></span>` +
    (c.favorite ? '<span class="star">★</span>' : '') +
    `<span class="label">${escapeHtml(c.name || c.host)}</span>`;
  conn.onclick = () => toggleConnection(c);
  conn.oncontextmenu = (e) => { e.preventDefault(); connMenu(e, c); };
  root.appendChild(conn);

  if (!ts.expanded) return;
  const dbWrap = document.createElement('div'); dbWrap.className = 'node-children';
  if (!ts.dbsLoaded) dbWrap.innerHTML = '<div class="node-loading">加载中…</div>';
  for (const [dbName, dbSt] of ts.dbs) {
    const dbNode = document.createElement('div'); dbNode.className = 'node lvl-db';
    dbNode.innerHTML = `<span class="twisty">${dbSt.expanded ? '▾' : '▸'}</span><span class="ico">🗄</span><span class="label">${escapeHtml(dbName)}</span>`;
    dbNode.onclick = () => toggleDatabase(c.id, dbName);
    dbNode.oncontextmenu = (e) => { e.preventDefault(); dbMenu(e, c.id, dbName); };
    dbWrap.appendChild(dbNode);
    if (dbSt.expanded) {
      const tWrap = document.createElement('div'); tWrap.className = 'node-children';
      if (!dbSt.tables) tWrap.innerHTML = '<div class="node-loading">加载中…</div>';
      else if (dbSt.tables.length === 0) tWrap.innerHTML = '<div class="node-loading">（无表）</div>';
      else for (const t of dbSt.tables) {
        const tn = document.createElement('div');
        const isActive = state.active.conn === c.id && state.active.db === dbName && state.active.table === t.name;
        tn.className = 'node lvl-table' + (isActive ? ' active' : '');
        tn.innerHTML = `<span class="twisty"></span><span class="ico">▦</span><span class="label">${escapeHtml(t.name)}</span>` + (t.rows != null ? `<span class="badge">${t.rows}</span>` : '');
        tn.onclick = () => openTable(c.id, dbName, t.name);
        tn.oncontextmenu = (e) => { e.preventDefault(); tableMenu(e, c.id, dbName, t.name); };
        tWrap.appendChild(tn);
      }
      dbWrap.appendChild(tWrap);
    }
  }
  root.appendChild(dbWrap);
}

function renderGroupHeader(root, key, label, count) {
  const collapsed = collapsedGroups.has(key);
  const h = document.createElement('div');
  h.className = 'group-header';
  h.innerHTML = `<span class="twisty">${collapsed ? '▸' : '▾'}</span><span class="g-name">${escapeHtml(label)}</span><span class="badge">${count}</span>`;
  h.onclick = () => { if (collapsed) collapsedGroups.delete(key); else collapsedGroups.add(key); persistCollapsed(); renderTree(); };
  root.appendChild(h);
  return collapsed;
}

function renderTree() {
  const root = $('#tree');
  if (!state.connections.length) { root.innerHTML = '<div class="tree-empty">暂无连接，点击右上角 ＋ 新建</div>'; return; }
  root.innerHTML = '';

  const favs = state.connections.filter((c) => c.favorite);
  const groups = new Map();
  for (const c of state.connections) {
    if (c.favorite) continue;
    const g = c.group || '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }

  if (favs.length) {
    const collapsed = renderGroupHeader(root, '__fav__', '★ 收藏', favs.length);
    if (!collapsed) favs.forEach((c) => renderConnNode(root, c));
  }
  [...groups.keys()].sort((a, b) => a.localeCompare(b)).forEach((g) => {
    const collapsed = renderGroupHeader(root, 'g:' + g, g, groups.get(g).length);
    if (!collapsed) groups.get(g).forEach((c) => renderConnNode(root, c));
  });
}

async function ensureConnected(c) {
  const ts = treeState(c.id);
  if (ts.connected) return true;
  setStatus('连接中…');
  const res = await window.api.connect(c);
  if (!res.ok) { toast('连接失败：' + res.error, 'err'); setStatus('连接失败'); return false; }
  ts.connected = true; ts.version = res.version || ''; ts.caps = res.caps || null; ts.dbType = res.type || c.type || 'mysql';
  setStatus('已连接');
  return true;
}
function connCaps() {
  const ts = state.activeConn && state.tree.has(state.activeConn) ? state.tree.get(state.activeConn) : null;
  return (ts && ts.caps) || { alter: true, dump: true, fk: true, index: true };
}
async function toggleConnection(c) {
  const ts = treeState(c.id);
  state.activeConn = c.id;
  if (!ts.connected) { if (!(await ensureConnected(c))) { renderTree(); return; } }
  ts.expanded = !ts.expanded;
  activateConnection(c);
  if (ts.expanded && !ts.dbsLoaded) {
    renderTree();
    const res = await window.api.databases(c.id);
    if (res.ok) { ts.dbs = new Map(res.data.map((d) => [d, { expanded: false, tables: null }])); ts.dbsLoaded = true; }
    else toast(res.error, 'err');
  }
  renderTree();
}
async function toggleDatabase(connId, dbName) {
  const ts = treeState(connId), dbSt = ts.dbs.get(dbName);
  dbSt.expanded = !dbSt.expanded;
  if (dbSt.expanded && !dbSt.tables) {
    renderTree();
    const res = await window.api.tables(connId, dbName);
    dbSt.tables = res.ok ? res.data : [];
    if (!res.ok) toast(res.error, 'err');
  }
  renderTree();
}
function activateConnection(c) {
  state.activeConn = c.id;
  $('#empty-state').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  const ts = treeState(c.id);
  $('#ws-info').textContent = `${c.user}@${c.host}:${c.port}`;
  const typeLabel = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL' }[ts.dbType || c.type || 'mysql'] || 'DB';
  $('#sb-conn').textContent = `${c.name || c.host}  ·  ${c.user}@${c.host}:${c.port}`;
  $('#sb-version').textContent = (ts.version ? `${typeLabel} · ${String(ts.version).slice(0, 40)}` : typeLabel);
  fillDbSelects(c.id);
}
async function fillDbSelects(connId) {
  const res = await window.api.databases(connId);
  if (!res.ok) return;
  const opts = ['<option value="">（选择数据库）</option>'].concat(res.data.map((d) => `<option value="${escAttr(d)}">${escapeHtml(d)}</option>`)).join('');
  ['#db-select', '#struct-db-select', '#data-db-select'].forEach((s) => { $(s).innerHTML = opts; });
  const c = state.connections.find((x) => x.id === connId);
  if (c && c.database && res.data.includes(c.database)) {
    $('#db-select').value = c.database; $('#struct-db-select').value = c.database; $('#data-db-select').value = c.database;
    onStructDbChange(); onDataDbChange();
  }
  loadSchemaPanel();
}
async function openTable(connId, db, table) {
  const c = state.connections.find((x) => x.id === connId);
  if (!c) return;
  if (state.activeConn !== connId) { if (!(await ensureConnected(c))) return; activateConnection(c); }
  state.active = { conn: connId, db, table };
  switchTab('data');
  $('#data-db-select').value = db; await onDataDbChange();
  $('#data-table-select').value = table;
  $('#data-where').value = '';
  state.data = { db, table, offset: 0, limit: 200, total: 0, sortCol: null, sortDir: 'asc', where: '', pk: [], colMeta: [] };
  await loadData(false);
  // 同步「表结构」标签到这张表，切过去即是它
  $('#struct-db-select').value = db;
  await onStructDbChange();
  $('#struct-table-select').value = table;
  await loadStructure();
  renderTree();
}

// ====================== 右键菜单 ======================
function showMenu(e, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = items.map((it) => it.sep ? '<div class="sep"></div>' : `<div class="ci ${it.danger ? 'danger' : ''}">${escapeHtml(it.label)}</div>`).join('');
  menu.classList.remove('hidden');
  const cis = menu.querySelectorAll('.ci'); let idx = 0;
  items.forEach((it) => { if (!it.sep) { const el = cis[idx++]; el.onclick = () => { menu.classList.add('hidden'); it.action(); }; } });
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}
document.addEventListener('click', () => $('#ctx-menu').classList.add('hidden'));

function connMenu(e, c) {
  const ts = treeState(c.id);
  showMenu(e, [
    { label: ts.connected ? '断开连接' : '连接', action: async () => {
        if (ts.connected) { await window.api.disconnect(c.id); ts.connected = false; ts.expanded = false; ts.dbsLoaded = false; ts.dbs = new Map(); renderTree(); }
        else { await ensureConnected(c); activateConnection(c); renderTree(); }
      } },
    { label: '刷新', action: async () => { ts.dbsLoaded = false; ts.dbs = new Map(); if (ts.connected && ts.expanded) { const r = await window.api.databases(c.id); if (r.ok) { ts.dbs = new Map(r.data.map((d) => [d, { expanded: false, tables: null }])); ts.dbsLoaded = true; } } renderTree(); } },
    { sep: true },
    { label: c.favorite ? '取消收藏' : '⭐ 收藏', action: () => toggleFavorite(c) },
    { label: '编辑连接', action: () => openModal(c) },
    { label: '删除连接', danger: true, action: () => deleteConn(c) },
  ]);
}
async function toggleFavorite(c) {
  await window.api.saveConnection({ ...c, favorite: !c.favorite, password: '' });
  await refreshConnections();
  toast(c.favorite ? '已取消收藏' : '已收藏：' + (c.name || c.host), 'ok');
}
function dbMenu(e, connId, db) {
  const caps = (state.tree.get(connId) || {}).caps || { dump: true };
  const items = [];
  if (caps.dump) items.push({ label: '导出整库为 SQL', action: async () => {
    if (!(await ensureConnected(state.connections.find((c) => c.id === connId)))) return;
    openDumpModal(connId, db, [], '导出整库为 SQL · ' + db);
  } });
  items.push({ label: '刷新', action: async () => {
    const ts = treeState(connId), dbSt = ts.dbs.get(db);
    if (dbSt) { const r = await window.api.tables(connId, db); dbSt.tables = r.ok ? r.data : null; renderTree(); }
  } });
  showMenu(e, items);
}
function tableMenu(e, connId, db, table) {
  const caps = (state.tree.get(connId) || {}).caps || { dump: true };
  const items = [
    { label: '浏览数据', action: () => openTable(connId, db, table) },
  ];
  if (caps.dump) items.push({ label: '导出为 SQL', action: () => openDumpModal(connId, db, [table], '导出表为 SQL · ' + table) });
  items.push(
    { label: '导入数据', action: async () => { const c = state.connections.find((x) => x.id === connId); if (!(await ensureConnected(c))) return; activateConnection(c); openImportModal(connId, db, table); } },
    { label: '查看结构', action: () => { switchTab('structure'); $('#struct-db-select').value = db; onStructDbChange().then(() => { $('#struct-table-select').value = table; setStructMode('columns'); }); } },
    { label: '复制建表语句', action: async () => { const r = await window.api.ddl(connId, db, table); if (r.ok) { await window.api.copy(r.ddl); toast('已复制建表语句', 'ok'); } else toast(r.error, 'err'); } },
    { label: '复制表名', action: async () => { await window.api.copy(table); toast('已复制表名', 'ok'); } },
    { label: 'SELECT 到查询', action: () => { switchTab('query'); $('#db-select').value = db; $('#sql-editor').value = `SELECT * FROM ${table} LIMIT 100;`; saveActiveQTab(); } },
    { label: '生成 SELECT 模板（列全字段）', action: () => genTemplate(connId, db, table, 'select') },
    { label: '生成 INSERT 模板', action: () => genTemplate(connId, db, table, 'insert') },
    { label: '生成 UPDATE 模板', action: () => genTemplate(connId, db, table, 'update') },
    { sep: true },
    { label: '清空表 (TRUNCATE)', danger: true, action: () => dangerOp(connId, db, table, 'truncate') },
    { label: '删除表 (DROP)', danger: true, action: () => dangerOp(connId, db, table, 'drop') },
  );
  showMenu(e, items);
}
async function dangerOp(connId, db, table, op) {
  const res = await window.api.dangerOp({ connId, database: db, table, op });
  if (res.canceled) return;
  if (!res.ok) { toast('操作失败：' + res.error, 'err'); return; }
  toast((op === 'truncate' ? '已清空 ' : '已删除 ') + table, 'ok');
  const ts = treeState(connId), dbSt = ts.dbs.get(db);
  if (dbSt) { const r = await window.api.tables(connId, db); dbSt.tables = r.ok ? r.data : []; renderTree(); }
}

// ====================== 连接 CRUD ======================
async function refreshConnections() { state.connections = await window.api.listConnections(); renderTree(); }
async function deleteConn(c) {
  await window.api.deleteConnection(c.id);
  state.tree.delete(c.id);
  if (state.activeConn === c.id) { state.activeConn = null; $('#workspace').classList.add('hidden'); $('#empty-state').classList.remove('hidden'); }
  toast('已删除连接：' + (c.name || c.host));
  await refreshConnections();
}

// ====================== 查询标签页 ======================
function activeTab() { return state.queryTabs.find((t) => t.id === state.activeQTab); }
function newQTab(sql = '') {
  const id = 'qt' + (++qtabSeq);
  state.queryTabs.push({ id, name: '查询 ' + qtabSeq, sql, db: '', result: null, statusText: '', statusCls: 'status' });
  state.activeQTab = id; renderQTabs(); loadQTab(activeTab());
}
function saveActiveQTab() { const t = activeTab(); if (!t) return; t.sql = $('#sql-editor').value; t.db = $('#db-select').value; }
function renderQTabs() {
  const host = $('#qtabs');
  host.innerHTML = state.queryTabs.map((t) => `
    <div class="qtab ${t.id === state.activeQTab ? 'active' : ''}" data-id="${t.id}">
      <span class="qt-name">${escapeHtml(t.name)}</span>
      ${state.queryTabs.length > 1 ? `<button class="qt-close" data-id="${t.id}">×</button>` : ''}
    </div>`).join('') + '<button class="qtab-add" id="qtab-add" title="新建查询">＋</button>';
  host.querySelectorAll('.qtab').forEach((el) => el.onclick = (e) => { if (e.target.classList.contains('qt-close')) return; switchQTab(el.dataset.id); });
  host.querySelectorAll('.qt-close').forEach((b) => b.onclick = (e) => { e.stopPropagation(); closeQTab(b.dataset.id); });
  $('#qtab-add').onclick = () => { saveActiveQTab(); newQTab(); };
}
function switchQTab(id) { if (id === state.activeQTab) return; saveActiveQTab(); state.activeQTab = id; renderQTabs(); loadQTab(activeTab()); }
function loadQTab(t) {
  if (!t) return;
  $('#sql-editor').value = t.sql || '';
  const sel = $('#db-select'); if ([...sel.options].some((o) => o.value === (t.db || ''))) sel.value = t.db || '';
  const st = $('#query-status'); st.textContent = t.statusText || ''; st.className = t.statusCls || 'status';
  applyQResult(t.result);
}
function applyQResult(r) {
  queryView.pager = null; queryView.fetchAll = null;
  if (!r) { queryView.setMessage('在上方输入 SQL 并点击执行，或按 Ctrl+Enter。'); return; }
  if (r.mode === 'data') queryView.setData(r.columns, r.rows);
  else if (r.mode === 'paged') {
    const p = r.qpage;
    queryView.pager = { offset: p.offset, pageSize: p.pageSize, total: p.total ?? (p.offset + r.rows.length), onPage: (no) => runQueryPage(no) };
    queryView.fetchAll = async () => fetchAllRows(p);
    queryView.setData(r.columns, r.rows);
  } else queryView.setMessage(r.html, r.cls || '');
}
function closeQTab(id) {
  const idx = state.queryTabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  state.queryTabs.splice(idx, 1);
  if (state.activeQTab === id) { const next = state.queryTabs[Math.max(0, idx - 1)]; state.activeQTab = next.id; renderQTabs(); loadQTab(next); }
  else renderQTabs();
}

// ====================== 查询执行 ======================
// 按 ; 切分多条语句，忽略字符串 / 反引号 / 注释中的分号
function splitStatements(sql) {
  const out = []; const n = sql.length; let start = 0, i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n) { if (sql[i] === '\\' && q !== '`') { i += 2; continue; } if (sql[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
    if (c === ';') { out.push({ start, end: i, text: sql.slice(start, i) }); i++; start = i; continue; }
    i++;
  }
  if (start < n) out.push({ start, end: n, text: sql.slice(start, n) });
  return out.filter((s) => s.text.trim());
}
// 定位光标所在的语句（光标落在分隔符/空白处时取最近的上一条）
function statementAt(sql, pos) {
  const stmts = splitStatements(sql);
  if (!stmts.length) return null;
  for (const s of stmts) { if (pos >= s.start && pos <= s.end) return s; }
  let best = stmts[0];
  for (const s of stmts) { if (s.end <= pos) best = s; }
  return best;
}
// 决定实际执行的 SQL：有选区 → 选区；多语句 → 光标所在语句；否则整个编辑器
function sqlToRun() {
  const editor = $('#sql-editor'), a = editor.selectionStart, b = editor.selectionEnd, v = editor.value;
  if (a !== b) return { sql: v.slice(a, b).trim(), partial: v.slice(a, b).trim() !== v.trim() };
  const stmts = splitStatements(v);
  if (stmts.length <= 1) return { sql: v.trim(), partial: false };
  const s = statementAt(v, a);
  const sql = (s ? s.text : v).trim();
  return { sql, partial: sql !== v.trim() };
}

// 工具栏中配置的每页行数（0 = 不分页 / 不限制）
function autoLimitValue() {
  const el = $('#query-limit'); if (!el) return 0;
  const n = parseInt(el.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// 能否对该 SQL 做分页（单条、SELECT/WITH、未自带 LIMIT 且无与尾部 LIMIT 冲突的子句）
function isPaginatable(baseSql) {
  if (splitStatements(baseSql).length !== 1) return false;
  const body = baseSql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(body)) return false;
  if (/\b(limit|for\s+update|for\s+share|into\s+(outfile|dumpfile)|procedure)\b/i.test(body)) return false;
  return true;
}
// 把用户查询包成子查询实现分页 / 计数（各方言都支持带别名的派生表）
function wrapPaged(base, size, offset) { return `SELECT * FROM (\n${base}\n) AS _q LIMIT ${size} OFFSET ${offset}`; }
function wrapCount(base) { return `SELECT COUNT(*) AS _cnt FROM (\n${base}\n) AS _q`; }
// 拉取完整结果集（导出「全部数据」用）——直接跑原始查询，不加分页
async function fetchAllRows(p) {
  const res = await window.api.query(state.activeConn, p.db, p.baseSql);
  if (!res.ok || res.type !== 'select') { if (res && res.error) toast('读取全部数据失败：' + res.error, 'err'); return null; }
  return { columns: res.columns, rows: res.rows };
}

async function runQuery() {
  if (!state.activeConn) { toast('请先选择一个连接', 'err'); return; }
  const run = sqlToRun();
  const baseSql = run.sql, partial = run.partial;
  if (!baseSql) { toast('请输入 SQL', 'err'); return; }
  const t = activeTab();
  const pageSize = autoLimitValue();

  // 可分页的 SELECT：建立分页状态并执行第一页（带翻页器，导出为全部数据）
  if (pageSize > 0 && isPaginatable(baseSql)) {
    if (t) t.qpage = { baseSql: baseSql.trim().replace(/;\s*$/, ''), db: $('#db-select').value || null, pageSize, offset: 0, total: null, partial };
    await window.api.historyAdd({ sql: baseSql, at: Date.now(), conn: state.activeConn });
    await runQueryPage(0);
    return;
  }

  // 其余情况（非 SELECT / 已自带 LIMIT / 每页设为 0 不限制）：单次执行
  if (t) t.qpage = null;
  queryView.pager = null; queryView.fetchAll = null;
  const db = $('#db-select').value || null;
  const tag = partial ? ' · 当前语句' : '';
  const st = $('#query-status'); st.textContent = '执行中…'; st.className = 'status';
  $('#btn-run').disabled = true;
  const res = await window.api.query(state.activeConn, db, baseSql);
  $('#btn-run').disabled = false;
  await window.api.historyAdd({ sql: baseSql, at: Date.now(), conn: state.activeConn });

  if (!res.ok) {
    st.textContent = '错误 · ' + res.elapsed + 'ms' + tag; st.className = 'status err';
    queryView.setMessage('❌ ' + escapeHtml(res.error), 'err');
    if (t) t.result = { mode: 'msg', html: '❌ ' + escapeHtml(res.error), cls: 'err' };
  } else if (res.type === 'select') {
    st.textContent = `${res.rowCount} 行 · ${res.elapsed}ms` + tag; st.className = 'status ok';
    if (res.rowCount === 0) { queryView.setMessage('查询成功，但没有返回任何行。'); if (t) t.result = { mode: 'msg', html: '查询成功，但没有返回任何行。' }; }
    else { queryView.setData(res.columns, res.rows); if (t) t.result = { mode: 'data', columns: res.columns, rows: res.rows }; }
  } else {
    st.textContent = `成功 · ${res.elapsed}ms` + tag; st.className = 'status ok';
    const html = `✓ 执行成功。影响行数：${res.affectedRows}` + (res.insertId ? `，insertId：${res.insertId}` : '') + ` · 耗时 ${res.elapsed}ms`;
    queryView.setMessage(html, 'ok'); if (t) t.result = { mode: 'msg', html, cls: 'ok' };
  }
  if (t) { t.statusText = st.textContent; t.statusCls = st.className; }
}

// 执行分页查询的某一页
async function runQueryPage(offset) {
  const t = activeTab(); if (!t || !t.qpage) return;
  const p = t.qpage; p.offset = Math.max(0, offset);
  const tag = p.partial ? ' · 当前语句' : '';
  const st = $('#query-status'); st.textContent = '执行中…'; st.className = 'status';
  $('#btn-run').disabled = true;
  const res = await window.api.query(state.activeConn, p.db, wrapPaged(p.baseSql, p.pageSize, p.offset));
  if (res.ok && res.type === 'select' && p.total === null) {
    const cres = await window.api.query(state.activeConn, p.db, wrapCount(p.baseSql));
    if (cres.ok && cres.rows && cres.rows.length) p.total = Number(Object.values(cres.rows[0])[0]);
  }
  $('#btn-run').disabled = false;

  if (!res.ok) { await runPagedFallback(p, tag); return; } // 包裹失败（如结果列名重复）→ 回退为普通 LIMIT
  const total = p.total ?? (p.offset + res.rowCount);
  const to = Math.min(p.offset + p.pageSize, total);
  st.textContent = `第 ${total === 0 ? 0 : p.offset + 1}–${to} 行 · 共 ${p.total ?? '?'} · ${res.elapsed}ms` + tag; st.className = 'status ok';
  if (!res.rowCount && p.offset === 0) {
    queryView.pager = null; queryView.fetchAll = null;
    queryView.setMessage('查询成功，但没有返回任何行。');
    if (t) t.result = { mode: 'msg', html: '查询成功，但没有返回任何行。' };
  } else {
    queryView.pager = { offset: p.offset, pageSize: p.pageSize, total, onPage: (no) => runQueryPage(no) };
    queryView.fetchAll = async () => fetchAllRows(p);
    queryView.setData(res.columns, res.rows);
    if (t) t.result = { mode: 'paged', columns: res.columns, rows: res.rows, qpage: { ...p } };
  }
  if (t) { t.statusText = st.textContent; t.statusCls = st.className; }
}

// 分页包裹执行失败时的回退：直接跑原查询 + LIMIT，不分页但仍支持导出全部
async function runPagedFallback(p, tag) {
  const t = activeTab();
  const res = await window.api.query(state.activeConn, p.db, p.baseSql + '\nLIMIT ' + p.pageSize);
  const st = $('#query-status');
  queryView.pager = null;
  if (!res.ok) {
    queryView.fetchAll = null;
    st.textContent = '错误 · ' + res.elapsed + 'ms' + tag; st.className = 'status err';
    queryView.setMessage('❌ ' + escapeHtml(res.error), 'err');
    if (t) { t.qpage = null; t.result = { mode: 'msg', html: '❌ ' + escapeHtml(res.error), cls: 'err' }; }
    return;
  }
  const hit = res.rowCount >= p.pageSize;
  queryView.fetchAll = async () => fetchAllRows(p);
  st.textContent = `${res.rowCount} 行 · ${res.elapsed}ms` + tag + (hit ? ` · 已限制 ${p.pageSize}（该查询无法分页，可能还有更多，导出仍为全部）` : '');
  st.className = hit ? 'status warn' : 'status ok';
  if (!res.rowCount) { queryView.fetchAll = null; queryView.setMessage('查询成功，但没有返回任何行。'); if (t) { t.qpage = null; t.result = { mode: 'msg', html: '查询成功，但没有返回任何行。' }; } }
  else { queryView.setData(res.columns, res.rows); if (t) { t.qpage = null; t.result = { mode: 'data', columns: res.columns, rows: res.rows }; } }
}

function formatSql() {
  let sql = $('#sql-editor').value;
  if (!sql.trim()) return;
  const kw = ['SELECT', 'FROM', 'WHERE', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'UNION', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM'];
  kw.forEach((k) => { sql = sql.replace(new RegExp('\\b' + k.replace(/ /g, '\\s+') + '\\b', 'gi'), '\n' + k); });
  sql = sql.replace(/\n\s*\n/g, '\n').replace(/^\n/, '').replace(/\s+,/g, ',');
  $('#sql-editor').value = sql.trim(); saveActiveQTab();
}

// Ctrl+/ 切换选中行（或当前行）的 -- 行注释
function toggleComment() {
  const el = $('#sql-editor'), v = el.value, a = el.selectionStart, b = el.selectionEnd;
  const ls = v.lastIndexOf('\n', a - 1) + 1;
  let le = v.indexOf('\n', b); if (le === -1) le = v.length;
  const block = v.slice(ls, le), lines = block.split('\n');
  const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*--\s?/.test(l));
  const next = lines.map((l) => {
    if (!l.trim()) return l;
    if (allCommented) return l.replace(/^(\s*)--\s?/, '$1');
    const indent = l.match(/^\s*/)[0];
    return indent + '-- ' + l.slice(indent.length);
  }).join('\n');
  el.value = v.slice(0, ls) + next + v.slice(le);
  el.setSelectionRange(ls, ls + next.length);
  saveActiveQTab();
}

// ====================== 自动补全 ======================
const acCache = new Map();
function invalidateAcCache() { acCache.clear(); }
const SQL_KW =['SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'LIKE', 'IN', 'BETWEEN', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE', 'DESC', 'ASC'];
const ac = { el: null, items: [], index: 0, token: null };
const acVisible = () => ac.el && !ac.el.classList.contains('hidden');
function hideAc() { if (ac.el) ac.el.classList.add('hidden'); }
function acKey() { return state.activeConn + ':' + ($('#db-select').value || ''); }
async function ensureAcData() {
  const key = acKey();
  if (acCache.has(key)) return;
  const db = $('#db-select').value;
  if (!state.activeConn || !db) { acCache.set(key, { tables: [], columns: [] }); return; }
  const res = await window.api.dbColumns(state.activeConn, db);
  if (!res.ok) { acCache.set(key, { tables: [], columns: [], byTable: {}, meta: {}, typeByName: {} }); return; }
  const tset = new Set(), cset = new Set(), byTable = {}, meta = {}, typeByName = {};
  res.data.forEach((r) => {
    tset.add(r.t); cset.add(r.c);
    (byTable[r.t] = byTable[r.t] || []).push(r.c);
    (meta[r.t] = meta[r.t] || {})[r.c] = { type: r.type || '', key: r.key || '' };
    if (!(r.c in typeByName)) typeByName[r.c] = r.type || '';
  });
  acCache.set(key, { tables: [...tset], columns: [...cset], byTable, meta, typeByName });
}
function acData() { return acCache.get(acKey()) || { tables: [], columns: [], byTable: {}, meta: {}, typeByName: {} }; }
function acPool() {
  const d = acData();
  return [
    ...d.tables.map((t) => ({ text: t, kind: '表' })),
    ...d.columns.map((c) => ({ text: c, kind: '列', hint: d.typeByName[c] || '' })),
    ...SQL_KW.map((k) => ({ text: k, kind: '关键字' })),
  ];
}
// 根据光标前的文本推断当前处于哪种子句上下文，用于给候选项排序
function clauseContext(before) {
  if (/\b(from|join|into|update|table)\s+[\w$]*$/i.test(before)) return 'table';
  if (/(\b(select|where|on|and|or|set|having|using|by|distinct)\b|[,(])\s*[\w$]*$/i.test(before)) return 'column';
  return 'general';
}
// 把候选项按「前缀优先 → 上下文相关的类型优先 → 字母序」排序
function rankItems(items, w, ctx) {
  const rank = ctx === 'table' ? { 表: 0, 列: 1, 关键字: 2 }
    : ctx === 'column' ? { 列: 0, 表: 1, 关键字: 2 }
    : { 关键字: 0, 表: 1, 列: 1 };
  return items.slice().sort((a, b) => {
    const as = a.text.toLowerCase().startsWith(w) ? 0 : 1, bs = b.text.toLowerCase().startsWith(w) ? 0 : 1;
    if (as !== bs) return as - bs;
    const ak = rank[a.kind] ?? 3, bk = rank[b.kind] ?? 3;
    if (ak !== bk) return ak - bk;
    return a.text.localeCompare(b.text);
  });
}
// 把限定符（可能是表名或 FROM/JOIN 中定义的别名）解析为真实表名
function resolveAlias(qualifier, sql, data) {
  const ql = qualifier.toLowerCase();
  const direct = data.tables.find((t) => t.toLowerCase() === ql);
  if (direct) return direct;
  const kw = new Set(['as', 'where', 'on', 'join', 'inner', 'left', 'right', 'outer', 'cross', 'using', 'group', 'order', 'set', 'having', 'limit']);
  const re = /\b(?:from|join|update|into)\s+`?([\w$]+)`?(?:\s+(?:as\s+)?`?([\w$]+)`?)?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const alias = m[2] && !kw.has(m[2].toLowerCase()) ? m[2] : null;
    if (alias && alias.toLowerCase() === ql) return data.tables.find((t) => t.toLowerCase() === m[1].toLowerCase()) || m[1];
  }
  return null;
}
function currentToken() {
  const el = $('#sql-editor'), pos = el.selectionStart;
  const m = el.value.slice(0, pos).match(/[\w$]+$/);
  if (!m) return null;
  return { word: m[0], start: pos - m[0].length, end: pos };
}
function caretCoords(el, pos) {
  const div = document.createElement('div'), style = getComputedStyle(el), s = div.style;
  s.position = 'absolute'; s.visibility = 'hidden'; s.whiteSpace = 'pre-wrap'; s.wordWrap = 'break-word';
  s.width = el.clientWidth + 'px';
  ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'borderTopWidth', 'borderLeftWidth'].forEach((p) => { s[p] = style[p]; });
  div.textContent = el.value.substring(0, pos);
  const span = document.createElement('span'); span.textContent = el.value.substring(pos) || '.';
  div.appendChild(span); document.body.appendChild(div);
  const top = span.offsetTop + parseInt(style.borderTopWidth || 0);
  const left = span.offsetLeft + parseInt(style.borderLeftWidth || 0);
  document.body.removeChild(div);
  return { top, left, lineHeight: parseInt(style.lineHeight) || 18 };
}
async function updateAc() {
  const editor = $('#sql-editor'), pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  await ensureAcData();
  const data = acData();

  // 限定符补全：alias. / table. → 只提示该表的字段
  const dot = before.match(/([\w$]+)\.([\w$]*)$/);
  if (dot) {
    const word = dot[2], w = word.toLowerCase();
    const table = resolveAlias(dot[1], editor.value, data);
    const cols = table && data.byTable[table] ? data.byTable[table] : data.columns;
    let items = cols.filter((c) => c.toLowerCase().includes(w)).map((c) => {
      const info = table && data.meta[table] ? data.meta[table][c] : null;
      return { text: c, kind: '列', hint: info ? info.type : (data.typeByName[c] || ''), pk: info ? info.key === 'PRI' : false };
    });
    items = rankItems(items, w, 'column').slice(0, 12);
    if (!items.length || (items.length === 1 && items[0].text.toLowerCase() === w)) { hideAc(); return; }
    ac.items = items; ac.index = 0; ac.token = { word, start: pos - word.length, end: pos }; renderAc();
    return;
  }

  const tok = currentToken();
  if (!tok || tok.word.length < 1) { hideAc(); return; }
  const w = tok.word.toLowerCase();
  const ctx = clauseContext(before);
  let items = acPool().filter((p) => p.text.toLowerCase().includes(w));
  items = rankItems(items, w, ctx).slice(0, 12);
  if (!items.length || (items.length === 1 && items[0].text.toLowerCase() === w)) { hideAc(); return; }
  ac.items = items; ac.index = 0; ac.token = tok; renderAc();
}
function renderAc() {
  const el = ac.el;
  el.innerHTML = ac.items.map((it, i) => `<div class="ac-item ${i === ac.index ? 'active' : ''}" data-i="${i}"><span>${escapeHtml(it.text)}${it.pk ? ' 🔑' : ''}</span><span class="ac-kind">${it.hint ? escapeHtml(it.hint) + ' · ' : ''}${it.kind}</span></div>`).join('');
  el.querySelectorAll('.ac-item').forEach((d) => { d.onmousedown = (e) => { e.preventDefault(); acAccept(ac.items[Number(d.dataset.i)]); }; });
  const editor = $('#sql-editor'), co = caretCoords(editor, editor.selectionStart);
  el.style.left = Math.max(0, Math.min(co.left, editor.clientWidth - 190)) + 'px';
  el.style.top = (co.top + co.lineHeight - editor.scrollTop + 4) + 'px';
  el.classList.remove('hidden');
}
function acAccept(item) {
  if (!item || !ac.token) return;
  const editor = $('#sql-editor'), v = editor.value, t = ac.token;
  editor.value = v.slice(0, t.start) + item.text + v.slice(t.end);
  const np = t.start + item.text.length;
  editor.setSelectionRange(np, np); hideAc(); editor.focus(); saveActiveQTab();
}

// ====================== SQL 辅助：片段库 / 模板生成 / 可视化构建器 ======================
// 按方言引用标识符（MySQL/MariaDB 反引号，PostgreSQL/SQLite 双引号）
function qbQuote(connId, name) {
  const t = (state.tree.get(connId) || {}).dbType || 'mysql';
  const ch = (t === 'postgres' || t === 'sqlite') ? '"' : '`';
  return ch + String(name).replace(new RegExp(ch, 'g'), ch + ch) + ch;
}
// 在编辑器光标处插入文本；若含 «占位符» 则选中第一个，方便直接覆盖输入
function insertSnippet(text) {
  const el = $('#sql-editor'), a = el.selectionStart, b = el.selectionEnd, v = el.value;
  const pre = (a > 0 && !/\n\s*$/.test(v.slice(0, a)) && v.slice(0, a).trim()) ? '\n' : '';
  const ins = pre + text;
  el.value = v.slice(0, a) + ins + v.slice(b);
  const ph = ins.indexOf('«');
  if (ph >= 0) { const end = ins.indexOf('»', ph); el.setSelectionRange(a + ph, a + (end >= 0 ? end + 1 : ph + 1)); }
  else { const np = a + ins.length; el.setSelectionRange(np, np); }
  el.focus(); saveActiveQTab();
}

// 在光标处插入纯文本（表名/字段名），不加换行、不选中
function insertText(text) {
  const el = $('#sql-editor'), a = el.selectionStart, b = el.selectionEnd, v = el.value;
  el.value = v.slice(0, a) + text + v.slice(b);
  const np = a + text.length; el.setSelectionRange(np, np); el.focus(); saveActiveQTab();
}
// Tab / Shift+Tab 在 «占位符» 之间跳转并选中；无占位符返回 false（交回默认行为）
function jumpToPlaceholder(back) {
  const el = $('#sql-editor'), v = el.value, spans = [];
  const re = /«[^»]*»/g; let m;
  while ((m = re.exec(v))) spans.push([m.index, m.index + m[0].length]);
  if (!spans.length) return false;
  let target;
  if (back) { const before = spans.filter((s) => s[1] <= el.selectionStart); target = before.length ? before[before.length - 1] : spans[spans.length - 1]; }
  else { const after = spans.filter((s) => s[0] >= el.selectionEnd); target = after.length ? after[0] : spans[0]; }
  el.setSelectionRange(target[0], target[1]); el.focus(); return true;
}

// ---- 常驻结构树（库→表→字段，点击插入） ----
const schema = { db: null, tables: [], cols: {}, expanded: new Set() };
function shortType(t) { const s = String(t || ''); return s.length > 16 ? s.slice(0, 15) + '…' : s; }
async function loadSchemaPanel() {
  const tree = $('#schema-tree'), db = $('#db-select').value;
  if (!state.activeConn || !db) { schema.db = null; schema.tables = []; tree.innerHTML = '<div class="sc-empty">选择数据库后显示表</div>'; return; }
  if (schema.db !== db) { schema.db = db; schema.cols = {}; schema.expanded = new Set(); }
  const res = await window.api.tables(state.activeConn, db);
  schema.tables = res.ok ? res.data.map((t) => t.name) : [];
  renderSchemaTree();
}
function renderSchemaTree() {
  const tree = $('#schema-tree');
  const query = ($('#schema-search').value || '').trim().toLowerCase();
  const rows = [];
  for (const t of schema.tables) {
    const cols = schema.cols[t] || null;
    const tableMatch = t.toLowerCase().includes(query);
    const colMatch = query && cols && cols.some((c) => c.name.toLowerCase().includes(query));
    if (query && !tableMatch && !colMatch) continue;
    const expanded = schema.expanded.has(t);
    rows.push(`<div class="sc-table ${expanded ? 'exp' : ''}" data-t="${escAttr(t)}"><span class="sc-caret">${expanded ? '▾' : '▸'}</span><span class="sc-name" data-t="${escAttr(t)}" title="双击生成 SELECT">${escapeHtml(t)}</span></div>`);
    if (expanded && cols) {
      for (const c of cols) {
        if (query && !tableMatch && !c.name.toLowerCase().includes(query)) continue;
        rows.push(`<div class="sc-col" data-c="${escAttr(c.name)}" title="${escAttr(c.name + ' ' + (c.type || ''))}"><span class="sc-cn">${c.key === 'PRI' ? '🔑 ' : ''}${escapeHtml(c.name)}</span><span class="sc-ct">${escapeHtml(shortType(c.type))}</span></div>`);
      }
    }
  }
  tree.innerHTML = rows.join('') || '<div class="sc-empty">无匹配</div>';
  tree.querySelectorAll('.sc-table').forEach((el) => {
    el.querySelector('.sc-caret').onclick = (e) => { e.stopPropagation(); toggleSchemaTable(el.dataset.t); };
    el.querySelector('.sc-name').onclick = () => insertText(el.dataset.t);
    el.ondblclick = () => { switchTab('query'); insertSnippet(`SELECT * FROM ${qbQuote(state.activeConn, el.dataset.t)} LIMIT 100;`); };
  });
  tree.querySelectorAll('.sc-col').forEach((el) => { el.onclick = () => insertText(el.dataset.c); });
}
async function toggleSchemaTable(t) {
  if (schema.expanded.has(t)) schema.expanded.delete(t);
  else {
    schema.expanded.add(t);
    if (!schema.cols[t]) { const r = await window.api.columns(state.activeConn, schema.db, t); schema.cols[t] = r.ok ? r.data : []; }
  }
  renderSchemaTree();
}

// ---- 片段库 ----
const SNIPPETS = [
  { group: '查询', items: [
    { name: 'SELECT', sql: 'SELECT * FROM «表» WHERE «条件» LIMIT 100;' },
    { name: '去重', sql: 'SELECT DISTINCT «字段» FROM «表»;' },
    { name: '计数', sql: 'SELECT COUNT(*) FROM «表» WHERE «条件»;' },
    { name: '分组统计', sql: 'SELECT «字段», COUNT(*) AS cnt\nFROM «表»\nGROUP BY «字段»\nORDER BY cnt DESC;' },
    { name: 'INNER JOIN', sql: 'SELECT a.*, b.*\nFROM «表a» a\nJOIN «表b» b ON a.«id» = b.«a_id»\nWHERE «条件»;' },
    { name: 'LEFT JOIN', sql: 'SELECT a.*, b.*\nFROM «表a» a\nLEFT JOIN «表b» b ON a.«id» = b.«a_id»;' },
    { name: '子查询 IN', sql: 'SELECT * FROM «表»\nWHERE «字段» IN (SELECT «字段» FROM «表2» WHERE «条件»);' },
    { name: '分页', sql: 'SELECT * FROM «表» ORDER BY «字段» LIMIT 20 OFFSET 0;' },
  ] },
  { group: '修改', items: [
    { name: 'INSERT', sql: 'INSERT INTO «表» («列1», «列2») VALUES («值1», «值2»);' },
    { name: 'UPDATE', sql: 'UPDATE «表» SET «列» = «值» WHERE «条件»;' },
    { name: 'DELETE', sql: 'DELETE FROM «表» WHERE «条件»;' },
    { name: 'UPSERT', sql: 'INSERT INTO «表» («列») VALUES («值»)\nON DUPLICATE KEY UPDATE «列» = VALUES(«列»);' },
  ] },
  { group: '结构', items: [
    { name: 'CREATE TABLE', sql: 'CREATE TABLE «表» (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  «列» VARCHAR(255) NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);' },
    { name: 'ADD COLUMN', sql: 'ALTER TABLE «表» ADD COLUMN «列» «类型»;' },
    { name: 'ADD INDEX', sql: 'ALTER TABLE «表» ADD INDEX «索引名» («列»);' },
    { name: 'CREATE VIEW', sql: 'CREATE VIEW «视图» AS\nSELECT «字段» FROM «表» WHERE «条件»;' },
  ] },
];
function renderSnippetBar() {
  const bar = $('#snippet-bar');
  bar.innerHTML = SNIPPETS.map((g) => `<div class="snip-group"><span class="snip-label">${escapeHtml(g.group)}</span>${
    g.items.map((it, i) => `<button class="snip-chip" data-g="${escAttr(g.group)}" data-i="${i}" title="${escAttr(it.sql)}">${escapeHtml(it.name)}</button>`).join('')
  }</div>`).join('');
  bar.querySelectorAll('.snip-chip').forEach((btn) => {
    btn.onclick = () => { const g = SNIPPETS.find((x) => x.group === btn.dataset.g); insertSnippet(g.items[Number(btn.dataset.i)].sql); };
  });
}
function toggleSnippetBar() { $('#snippet-bar').classList.toggle('hidden'); }

// ---- 右键表：一键生成完整语句模板 ----
function phFor(c) { return '«' + (c.type || '值') + '»'; }
function buildRowTemplate(kind, table, cols, connId) {
  const q = (n) => qbQuote(connId, n);
  if (kind === 'insert') {
    const ins = cols.filter((c) => !/auto_increment/i.test(c.extra || '')); // 跳过自增列
    return `INSERT INTO ${q(table)} (${ins.map((c) => q(c.name)).join(', ')})\nVALUES (${ins.map(phFor).join(', ')});`;
  }
  if (kind === 'update') {
    const pk = cols.filter((c) => c.key === 'PRI').map((c) => c.name);
    const whereCols = pk.length ? pk : (cols[0] ? [cols[0].name] : []);
    const setCols = cols.filter((c) => c.key !== 'PRI');
    return `UPDATE ${q(table)} SET\n  ${setCols.map((c) => `${q(c.name)} = ${phFor(c)}`).join(',\n  ')}\nWHERE ${whereCols.map((c) => `${q(c)} = «值»`).join(' AND ')};`;
  }
  return `SELECT ${cols.map((c) => q(c.name)).join(', ')}\nFROM ${q(table)}\nLIMIT 100;`;
}
async function genTemplate(connId, db, table, kind) {
  const c = state.connections.find((x) => x.id === connId);
  if (!c) return;
  if (state.activeConn !== connId) { if (!(await ensureConnected(c))) return; activateConnection(c); }
  const res = await window.api.columns(connId, db, table);
  if (!res.ok) { toast(res.error, 'err'); return; }
  if (!res.data.length) { toast('该表没有字段', 'err'); return; }
  switchTab('query'); $('#db-select').value = db;
  insertSnippet(buildRowTemplate(kind, table, res.data, connId));
  toast('已生成模板，可直接编辑', 'ok');
}

// ---- 可视化查询构建器 ----
const qb = { db: null, table: null, cols: [] };
async function openQueryBuilder() {
  if (!state.activeConn) { toast('请先选择一个连接', 'err'); return; }
  $('#qb-db').innerHTML = $('#db-select').innerHTML;
  $('#qb-db').value = $('#db-select').value || '';
  $('#qb-cond-list').innerHTML = '';
  $('#qb-order-dir').value = ''; $('#qb-limit').value = '100';
  $('#qb-modal').classList.remove('hidden');
  await qbLoadTables();
}
async function qbLoadTables() {
  const db = $('#qb-db').value; qb.db = db;
  const sel = $('#qb-table');
  if (!db) { sel.innerHTML = ''; qb.table = null; $('#qb-col-list').innerHTML = ''; $('#qb-order').innerHTML = ''; qbUpdate(); return; }
  const res = await window.api.tables(state.activeConn, db);
  const tbls = res.ok ? res.data : [];
  sel.innerHTML = tbls.map((t) => `<option value="${escAttr(t.name)}">${escapeHtml(t.name)}</option>`).join('');
  await qbLoadColumns();
}
async function qbLoadColumns() {
  const db = $('#qb-db').value, table = $('#qb-table').value;
  qb.table = table;
  if (!db || !table) { $('#qb-col-list').innerHTML = ''; $('#qb-order').innerHTML = ''; qbUpdate(); return; }
  const res = await window.api.columns(state.activeConn, db, table);
  qb.cols = res.ok ? res.data : [];
  $('#qb-col-list').innerHTML = qb.cols.map((c) => `<label class="qb-ck"><input type="checkbox" value="${escAttr(c.name)}" checked> ${escapeHtml(c.name)} <span class="qb-ct">${escapeHtml(c.type || '')}</span></label>`).join('');
  $('#qb-order').innerHTML = '<option value="">（不排序）</option>' + qb.cols.map((c) => `<option value="${escAttr(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  $('#qb-cond-list').innerHTML = '';
  qbUpdate();
}
function qbAddCond() {
  if (!qb.cols.length) { toast('请先选择表', 'err'); return; }
  const colOpts = qb.cols.map((c) => `<option value="${escAttr(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  const ops = ['=', '<>', '>', '>=', '<', '<=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'];
  const row = document.createElement('div');
  row.className = 'qb-cond-row';
  row.innerHTML = `<select class="db-select qb-c-col">${colOpts}</select><select class="db-select qb-c-op">${ops.map((o) => `<option>${o}</option>`).join('')}</select><input class="where-input qb-c-val" placeholder="值"><button class="btn tiny qb-c-del" title="删除条件">×</button>`;
  $('#qb-cond-list').appendChild(row);
  qbUpdate();
}
function qbStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function qbFmtVal(op, val) {
  if (op === 'IN') return `(${val})`;               // 用户填 1,2,3 —— 原样放进括号
  if (op === 'LIKE') return qbStr(val);
  if (/^-?\d+(\.\d+)?$/.test(val)) return val;      // 纯数字不加引号
  return qbStr(val);
}
function qbBuildSql() {
  if (!qb.table) return '';
  const q = (n) => qbQuote(state.activeConn, n);
  const checked = [...$('#qb-col-list').querySelectorAll('input:checked')].map((i) => i.value);
  const colSql = checked.length ? checked.map(q).join(', ') : '*';
  let sql = `SELECT ${colSql}\nFROM ${q(qb.table)}`;
  const conds = [];
  $('#qb-cond-list').querySelectorAll('.qb-cond-row').forEach((row) => {
    const col = row.querySelector('.qb-c-col').value;
    const op = row.querySelector('.qb-c-op').value;
    const valEl = row.querySelector('.qb-c-val');
    const nullOp = op === 'IS NULL' || op === 'IS NOT NULL';
    valEl.style.visibility = nullOp ? 'hidden' : 'visible';
    if (!col) return;
    if (nullOp) conds.push(`${q(col)} ${op}`);
    else if (valEl.value.trim() !== '') conds.push(`${q(col)} ${op} ${qbFmtVal(op, valEl.value.trim())}`);
  });
  if (conds.length) sql += `\nWHERE ${conds.join('\n  AND ')}`;
  const ob = $('#qb-order').value, od = $('#qb-order-dir').value;
  if (ob) sql += `\nORDER BY ${q(ob)}${od ? ' ' + od : ''}`;
  const lim = parseInt($('#qb-limit').value, 10);
  if (Number.isFinite(lim) && lim > 0) sql += `\nLIMIT ${lim}`;
  return sql + ';';
}
function qbUpdate() { $('#qb-sql').value = qbBuildSql(); }
function qbApply(run) {
  const sql = $('#qb-sql').value.trim();
  if (!sql) { toast('请先选择表', 'err'); return; }
  $('#db-select').value = $('#qb-db').value || '';
  $('#sql-editor').value = sql; saveActiveQTab();
  $('#qb-modal').classList.add('hidden');
  switchTab('query');
  if (run) runQuery(); else toast('已载入到查询编辑器', 'ok');
}

// ====================== 表结构 ======================
let structMode = 'columns';
async function onStructDbChange() {
  const db = $('#struct-db-select').value, sel = $('#struct-table-select');
  if (!db) { sel.innerHTML = ''; return; }
  const res = await window.api.tables(state.activeConn, db);
  if (!res.ok) { toast(res.error, 'err'); return; }
  sel.innerHTML = ['<option value="">（选择表）</option>'].concat(res.data.map((t) => `<option value="${escAttr(t.name)}">${escapeHtml(t.name)}</option>`)).join('');
  $('#structure-content').innerHTML = '';
}
function setStructMode(mode) { structMode = mode; $$('.seg-btn[data-struct]').forEach((b) => b.classList.toggle('active', b.dataset.struct === mode)); loadStructure(); }
// 段：字段 / 索引 / 外键 / 建表语句
async function loadStructure() {
  const db = $('#struct-db-select').value, table = $('#struct-table-select').value, host = $('#structure-content');
  if (!db || !table) { host.innerHTML = '<div class="result-msg">请选择数据库和表。</div>'; return; }
  if (structMode === 'ddl') {
    const res = await window.api.ddl(state.activeConn, db, table);
    if (!res.ok) { host.innerHTML = `<div class="result-msg err">${escapeHtml(res.error)}</div>`; return; }
    host.innerHTML = `<div class="result-toolbar"><button class="btn sm" id="ddl-copy">复制</button></div><pre class="ddl-box">${escapeHtml(res.ddl)}</pre>`;
    $('#ddl-copy').onclick = async () => { await window.api.copy(res.ddl); toast('已复制', 'ok'); };
    return;
  }
  if (structMode === 'indexes') {
    const res = await window.api.indexes(state.activeConn, db, table);
    if (!res.ok) { host.innerHTML = `<div class="result-msg err">${escapeHtml(res.error)}</div>`; return; }
    renderStructureIndexes(db, table, res.data);
    return;
  }
  if (structMode === 'fk') {
    const res = await window.api.foreignKeys(state.activeConn, db, table);
    if (!res.ok) { host.innerHTML = `<div class="result-msg err">${escapeHtml(res.error)}</div>`; return; }
    if (res.unsupported) { host.innerHTML = '<div class="result-msg">该数据库类型暂不支持外键的可视化管理，请用 SQL 操作。</div>'; return; }
    renderStructureForeignKeys(db, table, res.data);
    return;
  }
  const res = await window.api.columns(state.activeConn, db, table);
  if (!res.ok) { host.innerHTML = `<div class="result-msg err">${escapeHtml(res.error)}</div>`; return; }
  renderStructureColumns(db, table, res.data);
}

// 可编辑的字段结构视图
function renderStructureColumns(db, table, cols) {
  state.struct = { db, table, cols };
  const host = $('#structure-content');
  const editable = connCaps().alter;
  const body = cols.map((c, i) => `
    <tr data-i="${i}">
      <td class="rownum">${i + 1}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.type)}</td>
      <td>${c.nullable === 'YES' ? '是' : '否'}</td>
      <td>${escapeHtml(c.key || '')}</td>
      <td>${c.default === null || c.default === undefined ? '<span class="null">NULL</span>' : escapeHtml(String(c.default))}</td>
      <td>${escapeHtml(c.extra || '')}</td>
      <td>${escapeHtml(c.comment || '')}</td>
      ${editable ? `<td class="col-actions"><button class="btn sm" data-act="edit" data-i="${i}">编辑</button><button class="btn sm danger-btn" data-act="drop" data-i="${i}">删除</button></td>` : ''}
    </tr>`).join('');
  host.innerHTML = `
    <div class="result-toolbar">
      ${editable ? '<button class="btn sm primary" id="btn-add-col">＋ 新增字段</button>' : '<span class="rt-info">该数据库类型暂不支持可视化改字段，请用 SQL</span>'}
      <span class="rt-info">${cols.length} 个字段 · ${escapeHtml(db)}.${escapeHtml(table)}</span>
    </div>
    <div class="grid-wrap"><table class="grid">
      <thead><tr><th class="rownum">#</th><th>字段</th><th>类型</th><th>可空</th><th>键</th><th>默认值</th><th>额外</th><th>注释</th>${editable ? '<th>操作</th>' : ''}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  if (editable) {
    $('#btn-add-col').onclick = () => openColumnModal('add', null);
    host.querySelectorAll('button[data-act]').forEach((b) => b.onclick = () => {
      const c = state.struct.cols[Number(b.dataset.i)];
      if (b.dataset.act === 'edit') openColumnModal('modify', c); else dropColumn(c);
    });
  }
}

function openColumnModal(mode, col) {
  $('#col-title').textContent = mode === 'add' ? '新增字段' : '编辑字段：' + col.name;
  $('#col-mode').value = mode;
  $('#f-col-oldname').value = col ? col.name : '';
  $('#f-col-name').value = col ? col.name : '';
  $('#f-col-type').value = col ? col.type : '';
  $('#f-col-null').checked = col ? col.nullable === 'YES' : true;
  $('#f-col-default').value = col && col.default != null ? String(col.default) : '';
  $('#f-col-default-raw').checked = false;
  $('#f-col-comment').value = col ? (col.comment || '') : '';
  const posRow = $('#col-pos-row');
  if (mode === 'add') {
    posRow.style.display = '';
    const opts = ['<option value="">（默认：放在末尾）</option>', '<option value="__first__">放在最前面</option>']
      .concat((state.struct.cols || []).map((c) => `<option value="${escAttr(c.name)}">在 ${escapeHtml(c.name)} 之后</option>`));
    $('#f-col-after').innerHTML = opts.join('');
  } else posRow.style.display = 'none';
  $('#col-msg').textContent = ''; $('#col-msg').className = 'modal-msg';
  $('#col-modal').classList.remove('hidden');
  setTimeout(() => $('#f-col-name').focus(), 50);
}

async function submitColumn() {
  const mode = $('#col-mode').value;
  const defaultStr = $('#f-col-default').value;
  const defaultRaw = $('#f-col-default-raw').checked;
  const def = {
    name: $('#f-col-name').value.trim(),
    oldName: $('#f-col-oldname').value,
    type: $('#f-col-type').value.trim(),
    nullable: $('#f-col-null').checked,
    defaultProvided: defaultStr !== '',
    defaultValue: defaultStr,
    defaultRaw,
    comment: $('#f-col-comment').value.trim(),
  };
  if (!def.name) { $('#col-msg').textContent = '字段名不能为空'; $('#col-msg').className = 'modal-msg err'; return; }
  if (!def.type) { $('#col-msg').textContent = '类型不能为空'; $('#col-msg').className = 'modal-msg err'; return; }
  if (mode === 'add') {
    const after = $('#f-col-after').value;
    if (after === '__first__') def.first = true; else if (after) def.after = after;
  }
  const res = await window.api.columnOp({ connId: state.activeConn, database: state.struct.db, table: state.struct.table, op: mode, def });
  if (!res.ok) { $('#col-msg').textContent = '执行失败：' + res.error; $('#col-msg').className = 'modal-msg err'; return; }
  $('#col-modal').classList.add('hidden');
  toast(mode === 'add' ? '已新增字段 ' + def.name : '已修改字段 ' + def.name, 'ok');
  loadStructure();
  invalidateAcCache();
}

async function dropColumn(col) {
  const res = await window.api.columnOp({ connId: state.activeConn, database: state.struct.db, table: state.struct.table, op: 'drop', def: { name: col.name } });
  if (res.canceled) return;
  if (!res.ok) { toast('删除失败：' + res.error, 'err'); return; }
  toast('已删除字段 ' + col.name, 'ok');
  loadStructure();
  invalidateAcCache();
}

// 可编辑的索引视图（SHOW INDEX 行按索引名分组）
function renderStructureIndexes(db, table, rawRows) {
  state.struct = { db, table, cols: (state.struct && state.struct.table === table ? state.struct.cols : []) };
  state.struct.db = db; state.struct.table = table;
  const map = new Map();
  for (const r of rawRows) {
    const k = r.Key_name;
    if (!map.has(k)) map.set(k, { name: k, unique: Number(r.Non_unique) === 0, type: r.Index_type, cols: [] });
    map.get(k).cols.push({ seq: Number(r.Seq_in_index), col: r.Column_name });
  }
  const indexes = [...map.values()].map((ix) => ({ ...ix, columns: ix.cols.sort((a, b) => a.seq - b.seq).map((c) => c.col) }));
  const host = $('#structure-content');
  const editable = connCaps().index;
  const body = indexes.map((ix, i) => {
    const isPk = ix.name === 'PRIMARY';
    return `<tr data-i="${i}">
      <td class="rownum">${i + 1}</td>
      <td>${isPk ? '🔑 ' : ''}${escapeHtml(ix.name)}</td>
      <td>${escapeHtml(ix.columns.join(', '))}</td>
      <td>${isPk ? '主键' : (ix.unique ? '唯一' : '普通')}</td>
      <td>${escapeHtml(ix.type || '')}</td>
      ${editable ? `<td class="col-actions"><button class="btn sm danger-btn" data-act="drop" data-i="${i}">删除</button></td>` : ''}
    </tr>`;
  }).join('');
  const cols = editable ? 6 : 5;
  host.innerHTML = `
    <div class="result-toolbar">
      ${editable ? '<button class="btn sm primary" id="btn-add-idx">＋ 新增索引 / 主键</button>' : '<span class="rt-info">该数据库类型暂不支持可视化索引管理，请用 SQL</span>'}
      <span class="rt-info">${indexes.length} 个索引 · ${escapeHtml(db)}.${escapeHtml(table)}</span>
    </div>
    <div class="grid-wrap"><table class="grid">
      <thead><tr><th class="rownum">#</th><th>索引名</th><th>字段</th><th>类别</th><th>方式</th>${editable ? '<th>操作</th>' : ''}</tr></thead>
      <tbody>${body || `<tr><td colspan="${cols}" style="padding:16px;color:var(--text-mute)">该表暂无索引</td></tr>`}</tbody>
    </table></div>`;
  if (editable) {
    $('#btn-add-idx').onclick = () => openIndexModal();
    host.querySelectorAll('button[data-act="drop"]').forEach((b) => b.onclick = () => dropIndex(indexes[Number(b.dataset.i)]));
  }
}

async function openIndexModal() {
  const { db, table } = state.struct;
  const res = await window.api.columns(state.activeConn, db, table);
  const cols = res.ok ? res.data : [];
  state.struct.cols = cols;
  $('#idx-cols').innerHTML = cols.map((c) => `<label class="ck"><input type="checkbox" value="${escAttr(c.name)}" /> ${escapeHtml(c.name)} <span class="if-type">${escapeHtml(c.type)}</span></label>`).join('');
  $('#f-idx-type').value = 'INDEX';
  $('#f-idx-name').value = '';
  updateIdxNameState();
  $('#idx-msg').textContent = ''; $('#idx-msg').className = 'modal-msg';
  $('#idx-modal').classList.remove('hidden');
}
function updateIdxNameState() {
  const isPk = $('#f-idx-type').value === 'PRIMARY';
  const nameEl = $('#f-idx-name');
  nameEl.disabled = isPk;
  nameEl.placeholder = isPk ? '主键无需名称' : '如 idx_user_name';
}
async function submitIndex() {
  const type = $('#f-idx-type').value;
  const columns = [...$('#idx-cols').querySelectorAll('input:checked')].map((i) => i.value);
  const name = $('#f-idx-name').value.trim();
  if (!columns.length) { $('#idx-msg').textContent = '请至少选择一个字段'; $('#idx-msg').className = 'modal-msg err'; return; }
  if (type !== 'PRIMARY' && !name) { $('#idx-msg').textContent = '请填写索引名'; $('#idx-msg').className = 'modal-msg err'; return; }
  const res = await window.api.indexOp({ connId: state.activeConn, database: state.struct.db, table: state.struct.table, op: 'add', def: { type, name, columns } });
  if (!res.ok) { $('#idx-msg').textContent = '执行失败：' + res.error; $('#idx-msg').className = 'modal-msg err'; return; }
  $('#idx-modal').classList.add('hidden');
  toast(type === 'PRIMARY' ? '已设置主键' : '已新增索引 ' + name, 'ok');
  loadStructure();
}
async function dropIndex(ix) {
  const res = await window.api.indexOp({ connId: state.activeConn, database: state.struct.db, table: state.struct.table, op: 'drop', def: { name: ix.name } });
  if (res.canceled) return;
  if (!res.ok) { toast('删除失败：' + res.error, 'err'); return; }
  toast(ix.name === 'PRIMARY' ? '已删除主键' : '已删除索引 ' + ix.name, 'ok');
  loadStructure();
}

// 可编辑的外键视图
function renderStructureForeignKeys(db, table, rows) {
  state.struct = { db, table, cols: (state.struct && state.struct.table === table ? state.struct.cols : []) };
  state.struct.db = db; state.struct.table = table;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, { name: r.name, refTable: r.refTable, onDelete: r.onDelete, onUpdate: r.onUpdate, cols: [], refCols: [] });
    const g = map.get(r.name);
    g.cols.push({ pos: r.pos, col: r.col }); g.refCols.push({ pos: r.pos, col: r.refCol });
  }
  const fks = [...map.values()].map((f) => ({ ...f, columns: f.cols.sort((a, b) => a.pos - b.pos).map((c) => c.col), refColumns: f.refCols.sort((a, b) => a.pos - b.pos).map((c) => c.col) }));
  const host = $('#structure-content');
  const body = fks.map((f, i) => `
    <tr data-i="${i}">
      <td class="rownum">${i + 1}</td>
      <td>${escapeHtml(f.name)}</td>
      <td>${escapeHtml(f.columns.join(', '))}</td>
      <td>${escapeHtml(f.refTable)} (${escapeHtml(f.refColumns.join(', '))})</td>
      <td>${escapeHtml(f.onDelete || '')}</td>
      <td>${escapeHtml(f.onUpdate || '')}</td>
      <td class="col-actions"><button class="btn sm danger-btn" data-act="drop" data-i="${i}">删除</button></td>
    </tr>`).join('');
  host.innerHTML = `
    <div class="result-toolbar">
      <button class="btn sm primary" id="btn-add-fk">＋ 新增外键</button>
      <span class="rt-info">${fks.length} 个外键 · ${escapeHtml(db)}.${escapeHtml(table)}</span>
    </div>
    <div class="grid-wrap"><table class="grid">
      <thead><tr><th class="rownum">#</th><th>约束名</th><th>本表字段</th><th>引用</th><th>ON DELETE</th><th>ON UPDATE</th><th>操作</th></tr></thead>
      <tbody>${body || '<tr><td colspan="7" style="padding:16px;color:var(--text-mute)">该表暂无外键</td></tr>'}</tbody>
    </table></div>`;
  $('#btn-add-fk').onclick = () => openFkModal();
  host.querySelectorAll('button[data-act="drop"]').forEach((b) => b.onclick = () => dropForeignKey(fks[Number(b.dataset.i)]));
}

async function openFkModal() {
  const { db, table } = state.struct;
  const [colRes, tblRes] = await Promise.all([
    window.api.columns(state.activeConn, db, table),
    window.api.tables(state.activeConn, db),
  ]);
  const cols = colRes.ok ? colRes.data : [];
  const tbls = tblRes.ok ? tblRes.data : [];
  $('#f-fk-col').innerHTML = cols.map((c) => `<option value="${escAttr(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  $('#f-fk-rtable').innerHTML = ['<option value="">（选择引用表）</option>'].concat(tbls.map((t) => `<option value="${escAttr(t.name)}">${escapeHtml(t.name)}</option>`)).join('');
  $('#f-fk-rcol').innerHTML = '';
  $('#f-fk-name').value = '';
  $('#f-fk-ondelete').value = ''; $('#f-fk-onupdate').value = '';
  $('#fk-msg').textContent = ''; $('#fk-msg').className = 'modal-msg';
  $('#fk-modal').classList.remove('hidden');
}
async function onFkRefTableChange() {
  const rt = $('#f-fk-rtable').value;
  if (!rt) { $('#f-fk-rcol').innerHTML = ''; return; }
  const res = await window.api.columns(state.activeConn, state.struct.db, rt);
  const cols = res.ok ? res.data : [];
  $('#f-fk-rcol').innerHTML = cols.map((c) => `<option value="${escAttr(c.name)}">${escapeHtml(c.name)}</option>`).join('');
}
async function submitForeignKey() {
  const def = {
    name: $('#f-fk-name').value.trim(),
    column: $('#f-fk-col').value,
    refTable: $('#f-fk-rtable').value,
    refColumn: $('#f-fk-rcol').value,
    onDelete: $('#f-fk-ondelete').value,
    onUpdate: $('#f-fk-onupdate').value,
  };
  if (!def.column || !def.refTable || !def.refColumn) { $('#fk-msg').textContent = '请选择本表字段、引用表与引用字段'; $('#fk-msg').className = 'modal-msg err'; return; }
  const res = await window.api.fkOp({ connId: state.activeConn, database: state.struct.db, table: state.struct.table, op: 'add', def });
  if (!res.ok) { $('#fk-msg').textContent = '执行失败：' + res.error; $('#fk-msg').className = 'modal-msg err'; return; }
  $('#fk-modal').classList.add('hidden');
  toast('已新增外键', 'ok'); loadStructure();
}
async function dropForeignKey(fk) {
  const res = await window.api.fkOp({ connId: state.activeConn, database: state.struct.db, table: state.struct.table, op: 'drop', def: { name: fk.name } });
  if (res.canceled) return;
  if (!res.ok) { toast('删除失败：' + res.error, 'err'); return; }
  toast('已删除外键 ' + fk.name, 'ok'); loadStructure();
}

// ====================== 数据浏览 ======================
async function onDataDbChange() {
  const db = $('#data-db-select').value, sel = $('#data-table-select');
  if (!db) { sel.innerHTML = ''; return; }
  const res = await window.api.tables(state.activeConn, db);
  if (!res.ok) { toast(res.error, 'err'); return; }
  sel.innerHTML = ['<option value="">（选择表）</option>'].concat(res.data.map((t) => `<option value="${escAttr(t.name)}">${escapeHtml(t.name)}</option>`)).join('');
}
async function loadData(resetTable = true) {
  const db = $('#data-db-select').value, table = $('#data-table-select').value;
  if (!db || !table) { toast('请选择数据库和表', 'err'); return; }
  if (resetTable) state.data = { db, table, offset: 0, limit: 200, total: 0, sortCol: null, sortDir: 'asc', where: $('#data-where').value.trim(), pk: [], colMeta: [] };
  else { state.data.db = db; state.data.table = table; state.data.where = $('#data-where').value.trim(); }
  const d = state.data;

  // 取列信息以判断主键 / 支持编辑与新增
  const colRes = await window.api.columns(state.activeConn, db, table);
  d.colMeta = colRes.ok ? colRes.data : [];
  d.pk = d.colMeta.filter((m) => m.key === 'PRI').map((m) => m.name);
  dataView.editable = d.pk.length > 0; dataView.pk = d.pk;
  $('#data-edit-hint').textContent = dataView.editable
    ? `可编辑：双击单元格改值 · 点击行号选中行 · 右键单元格更多操作（主键：${d.pk.join(', ')}）`
    : '该表无主键，数据为只读（无法安全定位行进行修改/删除）';

  const res = await window.api.browse({ connId: state.activeConn, database: db, table, limit: d.limit, offset: d.offset, orderBy: d.sortCol, orderDir: d.sortDir, where: d.where });
  if (!res.ok) { dataView.setMessage(escapeHtml(res.error), 'err'); $('#data-pager').innerHTML = ''; return; }
  d.total = res.total;
  state.active = { conn: state.activeConn, db, table };
  dataView.setData(res.columns, res.rows, { sortCol: d.sortCol, sortDir: d.sortDir });
  setStatus(`${table}: ${res.total} 行 · ${res.elapsed}ms`);
  renderPager();
}
function renderPager() {
  const { offset, limit, total } = state.data;
  const from = total === 0 ? 0 : offset + 1, to = Math.min(offset + limit, total);
  $('#data-pager').innerHTML = `<button class="btn sm" id="pg-prev" ${offset <= 0 ? 'disabled' : ''}>‹</button><span>${from}-${to} / ${total}</span><button class="btn sm" id="pg-next" ${to >= total ? 'disabled' : ''}>›</button>`;
  const p = $('#pg-prev'), n = $('#pg-next');
  if (p) p.onclick = () => { state.data.offset = Math.max(0, offset - limit); loadData(false); };
  if (n) n.onclick = () => { state.data.offset = offset + limit; loadData(false); };
}

// 删除选中行
async function deleteSelectedRows() {
  if (!dataView.editable) { toast('该表无主键，无法删除', 'err'); return; }
  const sel = dataView.getSelected();
  if (!sel.length) { toast('请先点击行号选择要删除的行', 'err'); return; }
  const d = state.data;
  const wheres = sel.map((r) => { const w = {}; d.pk.forEach((k) => w[k] = r[k]); return w; });
  const res = await window.api.deleteRows({ connId: state.activeConn, database: d.db, table: d.table, wheres });
  if (res.canceled) return;
  if (!res.ok) { toast('删除失败：' + res.error, 'err'); return; }
  toast('已删除 ' + res.affectedRows + ' 行', 'ok'); loadData(false);
}

// 新增行
function openInsertModal() {
  const d = state.data;
  if (!d.table) { toast('请先选择并加载一个表', 'err'); return; }
  const meta = d.colMeta || [];
  if (!meta.length) { toast('无法获取列信息', 'err'); return; }
  $('#insert-title').textContent = '新增行 · ' + d.table;
  $('#insert-fields').innerHTML = meta.map((m) => {
    const extra = m.extra || '';
    const note = extra.includes('auto_increment') ? '自增，可留空' : (m.default != null ? '默认 ' + m.default : (m.nullable === 'YES' ? '可空' : '必填'));
    return `<div class="if-row" data-col="${escAttr(m.name)}">
      <div class="if-label">${escapeHtml(m.name)}<span class="if-type">${escapeHtml(m.type)}</span></div>
      <input type="text" class="if-input" placeholder="${escapeHtml(note)}" />
      <label class="if-null"><input type="checkbox" class="if-nullck" /> NULL</label>
    </div>`;
  }).join('');
  $('#insert-msg').textContent = ''; $('#insert-msg').className = 'modal-msg';
  $('#insert-modal').classList.remove('hidden');
}
async function submitInsert() {
  const d = state.data, values = {};
  $$('#insert-fields .if-row').forEach((rowEl) => {
    const col = rowEl.dataset.col, input = rowEl.querySelector('.if-input'), nullck = rowEl.querySelector('.if-nullck');
    if (nullck.checked) values[col] = null;
    else if (input.value !== '') values[col] = input.value;
  });
  if (!Object.keys(values).length) { $('#insert-msg').textContent = '请至少填写一个字段（或勾选 NULL）'; $('#insert-msg').className = 'modal-msg err'; return; }
  const res = await window.api.insertRow({ connId: state.activeConn, database: d.db, table: d.table, values });
  if (!res.ok) { $('#insert-msg').textContent = '插入失败：' + res.error; $('#insert-msg').className = 'modal-msg err'; return; }
  $('#insert-modal').classList.add('hidden');
  toast('已插入' + (res.insertId ? '，insertId=' + res.insertId : ''), 'ok'); loadData(false);
}

// ====================== 历史 ======================
let historyCache = [];
async function loadHistory() { historyCache = await window.api.historyList(); renderHistory(); }
function renderHistory() {
  const f = ($('#history-filter').value || '').toLowerCase();
  const list = historyCache.filter((h) => !f || h.sql.toLowerCase().includes(f)), host = $('#history-list');
  if (!list.length) { host.innerHTML = '<div class="result-msg">暂无历史记录。</div>'; return; }
  host.innerHTML = list.map((h) => `<div class="history-item" data-sql="${escAttr(h.sql)}"><div class="hi-sql">${escapeHtml(h.sql.length > 400 ? h.sql.slice(0, 400) + '…' : h.sql)}</div><div class="hi-meta"><span>${fmtTime(h.at)}</span><span>点击载入查询</span></div></div>`).join('');
  host.querySelectorAll('.history-item').forEach((it) => it.onclick = () => { $('#sql-editor').value = it.dataset.sql; saveActiveQTab(); switchTab('query'); toast('已载入到查询编辑器'); });
}

// ====================== 弹窗 ======================
function openModal(cfg) {
  $('#modal-title').textContent = cfg ? '编辑连接' : '新建连接';
  $('#f-id').value = cfg ? cfg.id : '';
  $('#f-type').value = cfg ? (cfg.type || 'mysql') : 'mysql';
  $('#f-name').value = cfg ? (cfg.name || '') : '';
  $('#f-host').value = cfg ? cfg.host : '127.0.0.1';
  $('#f-port').value = cfg ? cfg.port : '3306';
  $('#f-user').value = cfg ? cfg.user : 'root';
  $('#f-password').value = '';
  $('#f-password').placeholder = (cfg && cfg.hasPassword) ? '已保存，留空表示不修改' : '';
  $('#f-database').value = cfg && cfg.type !== 'sqlite' ? (cfg.database || '') : '';
  $('#f-sqlite-file').value = cfg && cfg.type === 'sqlite' ? (cfg.database || '') : '';
  $('#f-ssl').checked = cfg ? !!cfg.ssl : false;
  $('#f-group').value = cfg ? (cfg.group || '') : '';
  applyConnTypeUI();
  $('#f-favorite').checked = cfg ? !!cfg.favorite : false;
  const groups = [...new Set(state.connections.map((c) => c.group).filter(Boolean))];
  $('#group-list').innerHTML = groups.map((g) => `<option value="${escAttr(g)}">`).join('');
  $('#modal-msg').textContent = ''; $('#modal-msg').className = 'modal-msg';
  $('#modal').classList.remove('hidden');
  setTimeout(() => $('#f-name').focus(), 50);
}
function closeModal() { $('#modal').classList.add('hidden'); }
function applyConnTypeUI() {
  const isSqlite = $('#f-type').value === 'sqlite';
  $('#sqlite-fields').classList.toggle('hidden', !isSqlite);
  $('#server-fields').classList.toggle('hidden', isSqlite);
}
function collectForm() {
  const type = $('#f-type').value;
  const common = { id: $('#f-id').value || undefined, type, group: $('#f-group').value.trim(), favorite: $('#f-favorite').checked, password: '' };
  if (type === 'sqlite') {
    const file = $('#f-sqlite-file').value.trim();
    return { ...common, name: $('#f-name').value.trim() || file.split(/[\\/]/).pop() || 'SQLite', host: '', port: 0, user: '', database: file, ssl: false };
  }
  return {
    ...common,
    name: $('#f-name').value.trim() || $('#f-host').value.trim(),
    host: $('#f-host').value.trim(), port: Number($('#f-port').value) || 3306,
    user: $('#f-user').value.trim(), password: $('#f-password').value,
    database: $('#f-database').value.trim(), ssl: $('#f-ssl').checked,
  };
}
async function testConn() {
  const cfg = collectForm(), msg = $('#modal-msg');
  msg.textContent = '测试中…'; msg.className = 'modal-msg';
  const res = await window.api.test(cfg);
  if (res.ok) { msg.textContent = '✓ 连接成功 · MySQL ' + (res.version || ''); msg.className = 'modal-msg ok'; }
  else { msg.textContent = '✗ ' + res.error; msg.className = 'modal-msg err'; }
}
async function saveConn() {
  const cfg = collectForm();
  if (!cfg.host || !cfg.user) { $('#modal-msg').textContent = '主机和用户名必填'; $('#modal-msg').className = 'modal-msg err'; return; }
  const saved = await window.api.saveConnection(cfg);
  if (cfg.id) { const ts = treeState(cfg.id); ts.connected = false; ts.dbsLoaded = false; ts.dbs = new Map(); }
  closeModal(); await refreshConnections(); toast('已保存连接：' + saved.name, 'ok');
}

// ====================== Tab 切换 ======================
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'history') loadHistory();
}

// ====================== 结果图表 ======================
const CHART_COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7', '#74c7ec', '#fab387', '#94e2d5', '#eba0ac', '#b4befe'];
let chartSrc = { columns: [], rows: [] };

function isNumericColumn(rows, col) {
  let seen = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === '') continue;
    seen++;
    if (isNaN(Number(v))) return false;
    if (seen >= 8) break;
  }
  return seen > 0;
}
function openChartModal(columns, rows) {
  if (!columns.length || !rows.length) { toast('没有可绘制的数据', 'err'); return; }
  chartSrc = { columns, rows };
  const numCols = columns.filter((c) => isNumericColumn(rows, c));
  $('#chart-x').innerHTML = columns.map((c) => `<option value="${escAttr(c)}">${escapeHtml(c)}</option>`).join('');
  $('#chart-y').innerHTML = (numCols.length ? numCols : columns).map((c) => `<option value="${escAttr(c)}">${escapeHtml(c)}</option>`).join('');
  $('#chart-x').value = columns[0];
  $('#chart-y').value = (numCols[0] || columns[Math.min(1, columns.length - 1)]);
  $('#chart-modal').classList.remove('hidden');
  renderChart();
}
function renderChart() {
  const type = $('#chart-type').value, xcol = $('#chart-x').value, ycol = $('#chart-y').value;
  const area = $('#chart-area');
  const max = type === 'line' ? 200 : 50;
  let rows = chartSrc.rows;
  let note = '';
  if (rows.length > max) { note = `数据较多，仅绘制前 ${max} 行（共 ${rows.length} 行）。`; rows = rows.slice(0, max); }
  const cats = rows.map((r) => r[xcol]);
  const vals = rows.map((r) => { const n = Number(r[ycol]); return isNaN(n) ? 0 : n; });
  if (!vals.length) { area.innerHTML = '<div class="chart-empty">无数据</div>'; return; }
  let svg;
  if (type === 'pie') svg = pieChart(cats, vals);
  else svg = axisChart(type, cats, vals, ycol);
  area.innerHTML = (note ? `<div class="chart-note">${escapeHtml(note)}</div>` : '') + svg;
}
function niceLabel(v) { const s = v === null || v === undefined ? 'NULL' : String(v); return s.length > 14 ? s.slice(0, 13) + '…' : s; }

function axisChart(type, cats, vals, ylabel) {
  const W = 720, H = 340, mL = 56, mR = 16, mT = 16, mB = 70;
  const iw = W - mL - mR, ih = H - mT - mB;
  const maxV = Math.max(...vals, 0), minV = Math.min(...vals, 0);
  const span = (maxV - minV) || 1;
  const y = (v) => mT + ih - ((v - minV) / span) * ih;
  const n = vals.length;
  const step = iw / n;
  // 网格 + Y 轴刻度
  let grid = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = minV + (span * i) / ticks, yy = y(val);
    grid += `<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${W - mR}" y2="${yy.toFixed(1)}" style="stroke:var(--surface)" stroke-width="1"/>`;
    grid += `<text x="${mL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" style="fill:var(--text-mute)">${fmtNum(val)}</text>`;
  }
  let body = '';
  if (type === 'bar') {
    const bw = Math.max(2, step * 0.62);
    vals.forEach((v, i) => {
      const cx = mL + step * i + step / 2, yy = y(v), y0 = y(Math.max(0, minV));
      const top = Math.min(yy, y0), hgt = Math.abs(yy - y0);
      body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, hgt).toFixed(1)}" rx="2" fill="${CHART_COLORS[i % CHART_COLORS.length]}"><title>${escapeHtml(niceLabel(cats[i]))}: ${v}</title></rect>`;
    });
  } else {
    const pts = vals.map((v, i) => `${(mL + step * i + step / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    body += `<polyline points="${pts}" fill="none" stroke="${CHART_COLORS[0]}" stroke-width="2"/>`;
    vals.forEach((v, i) => { body += `<circle cx="${(mL + step * i + step / 2).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${CHART_COLORS[0]}"><title>${escapeHtml(niceLabel(cats[i]))}: ${v}</title></circle>`; });
  }
  // X 轴标签（最多 ~16 个，避免拥挤）
  let xlabels = '';
  const everyX = Math.ceil(n / 16);
  cats.forEach((cat, i) => {
    if (i % everyX !== 0) return;
    const cx = mL + step * i + step / 2;
    xlabels += `<text x="${cx.toFixed(1)}" y="${H - mB + 16}" text-anchor="end" font-size="10" style="fill:var(--text-mute)" transform="rotate(-40 ${cx.toFixed(1)} ${H - mB + 16})">${escapeHtml(niceLabel(cat))}</text>`;
  });
  const axis = `<line x1="${mL}" y1="${mT}" x2="${mL}" y2="${mT + ih}" style="stroke:var(--surface-2)"/><line x1="${mL}" y1="${mT + ih}" x2="${W - mR}" y2="${mT + ih}" style="stroke:var(--surface-2)"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${grid}${axis}${body}${xlabels}<text x="${mL}" y="12" font-size="11" style="fill:var(--text-dim)">${escapeHtml(ylabel)}</text></svg>`;
}

function pieChart(cats, vals) {
  const W = 720, H = 340, cx = 180, cy = H / 2, r = 130;
  const data = vals.map((v) => Math.max(0, v));
  const total = data.reduce((a, b) => a + b, 0);
  if (total <= 0) return '<div class="chart-empty">数值之和为 0，无法绘制饼图</div>';
  let ang = -Math.PI / 2, slices = '';
  const legend = [];
  data.forEach((v, i) => {
    const frac = v / total, a2 = ang + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const color = CHART_COLORS[i % CHART_COLORS.length];
    if (frac > 0) slices += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}"><title>${escapeHtml(niceLabel(cats[i]))}: ${v} (${(frac * 100).toFixed(1)}%)</title></path>`;
    legend.push(`<div class="lg"><span class="sw" style="background:${color}"></span>${escapeHtml(niceLabel(cats[i]))} · ${(frac * 100).toFixed(1)}%</div>`);
    ang = a2;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${slices}</svg><div class="chart-legend">${legend.join('')}</div>`;
}
function fmtNum(v) { const a = Math.abs(v); if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'; return Number.isInteger(v) ? String(v) : v.toFixed(1); }

// ====================== 数据导入 ======================
function openImportModal(connId, db, table) {
  if (!table) { toast('请先选择一个表', 'err'); return; }
  state.import = { connId, db, table, file: '', isSql: false, srcCols: [], total: 0 };
  $('#import-table').textContent = table;
  $('#import-file').value = ''; $('#import-format').value = 'auto'; $('#import-mode').value = 'append';
  $('#import-meta').textContent = ''; $('#import-mapping').innerHTML = ''; $('#import-msg').textContent = ''; $('#import-msg').className = 'modal-msg';
  $('#import-progress').classList.add('hidden'); $('#import-fill').style.width = '0%'; $('#import-ptext').textContent = '';
  $('#import-modal').classList.remove('hidden');
}
async function pickImportFile() {
  const res = await window.api.openFile({ title: '选择导入文件', filters: [{ name: '数据文件', extensions: ['csv', 'xlsx', 'xls', 'json', 'sql'] }, { name: '所有文件', extensions: ['*'] }] });
  if (!res.ok) return;
  state.import.file = res.path; $('#import-file').value = res.path;
  await importPreview();
}
async function importPreview() {
  const i = state.import; if (!i || !i.file) return;
  $('#import-msg').textContent = '解析中…'; $('#import-msg').className = 'modal-msg';
  const res = await window.api.importPreview({ filePath: i.file, format: $('#import-format').value });
  if (!res.ok) { $('#import-msg').textContent = '解析失败：' + res.error; $('#import-msg').className = 'modal-msg err'; return; }
  $('#import-msg').textContent = '';
  if (res.format === 'sql') {
    i.isSql = true;
    $('#import-meta').textContent = `SQL 脚本（约 ${res.length} 字符）—— 将直接执行，忽略字段映射与冲突处理。`;
    $('#import-mapping').innerHTML = '';
    return;
  }
  i.isSql = false; i.srcCols = res.columns; i.total = res.total;
  $('#import-meta').textContent = `共 ${res.total} 行 · 来源列：${res.columns.join(', ')}`;
  const colRes = await window.api.columns(i.connId, i.db, i.table);
  buildImportMapping(colRes.ok ? colRes.data : [], res.columns);
}
function buildImportMapping(targetCols, srcCols) {
  const lower = srcCols.map((s) => s.toLowerCase());
  const head = '<div class="im-head"><span>目标字段</span><span></span><span>来源列</span></div>';
  const rows = targetCols.map((tc) => {
    const idx = lower.indexOf(tc.name.toLowerCase());
    const match = idx >= 0 ? srcCols[idx] : '';
    const opts = ['<option value="">（不导入）</option>']
      .concat(srcCols.map((s) => `<option value="${escAttr(s)}" ${s === match ? 'selected' : ''}>${escapeHtml(s)}</option>`)).join('');
    return `<div class="im-row">
      <div class="im-target">${escapeHtml(tc.name)} ${tc.key === 'PRI' ? '<span class="im-pk">🔑</span>' : ''}<span style="color:var(--text-mute);font-size:11px">${escapeHtml(tc.type)}</span></div>
      <div class="im-arrow">←</div>
      <select data-target="${escAttr(tc.name)}">${opts}</select>
    </div>`;
  }).join('');
  $('#import-mapping').innerHTML = head + rows;
}
async function runImport() {
  const i = state.import; if (!i || !i.file) { $('#import-msg').textContent = '请先选择文件'; $('#import-msg').className = 'modal-msg err'; return; }
  const format = $('#import-format').value, mode = $('#import-mode').value;
  let mapping = [];
  if (!i.isSql) {
    mapping = [...$('#import-mapping').querySelectorAll('select[data-target]')].map((s) => ({ target: s.dataset.target, source: s.value })).filter((m) => m.source);
    if (!mapping.length) { $('#import-msg').textContent = '请至少映射一个字段'; $('#import-msg').className = 'modal-msg err'; return; }
  }
  $('#btn-import-run').disabled = true;
  $('#import-progress').classList.remove('hidden'); $('#import-fill').style.width = '0%'; $('#import-ptext').textContent = '导入中…';
  $('#import-msg').textContent = '';
  const res = await window.api.importData({ connId: i.connId, database: i.db, table: i.table, format, filePath: i.file, mapping, mode });
  $('#btn-import-run').disabled = false;
  if (!res.ok) { $('#import-progress').classList.add('hidden'); $('#import-msg').textContent = '导入失败：' + res.error; $('#import-msg').className = 'modal-msg err'; return; }
  if (res.executed) toast('SQL 脚本已执行', 'ok');
  else { $('#import-fill').style.width = '100%'; $('#import-ptext').textContent = `完成 ${res.inserted} / ${res.total}`; toast(`成功导入 ${res.inserted} 行`, 'ok'); }
  $('#import-modal').classList.add('hidden');
  if (state.active.conn === i.connId && state.active.db === i.db && state.active.table === i.table) loadData(false);
}

// ====================== 数据库结构对比 ======================
function sqlQuote(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
function snapColDef(c) {
  let s = '`' + c.name.replace(/`/g, '``') + '` ' + c.type;
  s += c.nullable === 'YES' ? ' NULL' : ' NOT NULL';
  if (c.extra && /auto_increment/i.test(c.extra)) s += ' AUTO_INCREMENT';
  if (c.default != null) {
    const d = String(c.default);
    if (/^(CURRENT_TIMESTAMP|NULL)\b/i.test(d) || /^-?\d+(\.\d+)?$/.test(d)) s += ' DEFAULT ' + d;
    else s += ' DEFAULT ' + sqlQuote(d);
  }
  return s;
}
function colKey(c) { return [c.type, c.nullable, c.default == null ? '∅' : c.default, c.extra || ''].join('|'); }

function diffSchema(src, tgt) {
  const sNames = Object.keys(src), tNames = Object.keys(tgt);
  const sSet = new Set(sNames), tSet = new Set(tNames);
  const tablesAdd = sNames.filter((t) => !tSet.has(t));
  const tablesDrop = tNames.filter((t) => !sSet.has(t));
  const tableChanges = [];
  for (const t of sNames) {
    if (!tSet.has(t)) continue;
    const sc = src[t], tc = tgt[t];
    const scMap = new Map(sc.map((c) => [c.name, c])), tcMap = new Map(tc.map((c) => [c.name, c]));
    const colsAdd = sc.filter((c) => !tcMap.has(c.name));
    const colsDrop = tc.filter((c) => !scMap.has(c.name)).map((c) => c.name);
    const colsMod = [];
    for (const c of sc) { const o = tcMap.get(c.name); if (o && colKey(c) !== colKey(o)) colsMod.push({ src: c, tgt: o }); }
    if (colsAdd.length || colsDrop.length || colsMod.length) tableChanges.push({ table: t, colsAdd, colsDrop, colsMod });
  }
  return { tablesAdd, tablesDrop, tableChanges };
}

function openCompareModal() {
  const opts = ['<option value="">（选择连接）</option>']
    .concat(state.connections.map((c) => `<option value="${escAttr(c.id)}">${escapeHtml(c.name || c.host)}</option>`)).join('');
  $('#cmp-src-conn').innerHTML = opts; $('#cmp-tgt-conn').innerHTML = opts;
  $('#cmp-src-db').innerHTML = ''; $('#cmp-tgt-db').innerHTML = '';
  $('#cmp-summary').innerHTML = ''; $('#cmp-sql').value = '';
  $('#cmp-modal').classList.remove('hidden');
  if (state.activeConn) {
    $('#cmp-src-conn').value = state.activeConn; $('#cmp-tgt-conn').value = state.activeConn;
    fillCmpDbs('src'); fillCmpDbs('tgt');
  }
}
async function fillCmpDbs(side) {
  const connId = $(side === 'src' ? '#cmp-src-conn' : '#cmp-tgt-conn').value;
  const sel = $(side === 'src' ? '#cmp-src-db' : '#cmp-tgt-db');
  if (!connId) { sel.innerHTML = ''; return; }
  const c = state.connections.find((x) => x.id === connId);
  if (!(await ensureConnected(c))) { sel.innerHTML = ''; return; }
  const res = await window.api.databases(connId);
  sel.innerHTML = res.ok ? res.data.map((d) => `<option value="${escAttr(d)}">${escapeHtml(d)}</option>`).join('') : '';
}
async function runCompare() {
  const sConn = $('#cmp-src-conn').value, sDb = $('#cmp-src-db').value;
  const tConn = $('#cmp-tgt-conn').value, tDb = $('#cmp-tgt-db').value;
  if (!sConn || !sDb || !tConn || !tDb) { toast('请选择源与目标的连接和数据库', 'err'); return; }
  if (sConn === tConn && sDb === tDb) { toast('源与目标是同一个库', 'err'); return; }
  setStatus('对比中…');
  const [sSnap, tSnap] = await Promise.all([window.api.schemaSnapshot(sConn, sDb), window.api.schemaSnapshot(tConn, tDb)]);
  if (!sSnap.ok) { toast('源快照失败：' + sSnap.error, 'err'); return; }
  if (!tSnap.ok) { toast('目标快照失败：' + tSnap.error, 'err'); return; }
  const diff = diffSchema(sSnap.tables, tSnap.tables);
  let sql = `-- 使目标库「${tDb}」结构向源库「${sDb}」对齐\n-- 执行前请务必审阅\nSET FOREIGN_KEY_CHECKS = 0;\n\n`;
  for (const t of diff.tablesAdd) {
    const d = await window.api.ddl(sConn, sDb, t);
    if (d.ok) sql += d.ddl + ';\n\n';
  }
  for (const t of diff.tablesDrop) sql += `-- 目标多出的表（默认保留，如需删除取消注释）：\n-- DROP TABLE \`${t}\`;\n\n`;
  for (const td of diff.tableChanges) {
    const stmts = [];
    td.colsAdd.forEach((c) => stmts.push('ADD COLUMN ' + snapColDef(c)));
    td.colsMod.forEach((c) => stmts.push('MODIFY COLUMN ' + snapColDef(c.src)));
    td.colsDrop.forEach((name) => stmts.push('DROP COLUMN `' + name + '`'));
    if (stmts.length) sql += `ALTER TABLE \`${td.table}\`\n  ` + stmts.join(',\n  ') + ';\n\n';
  }
  sql += 'SET FOREIGN_KEY_CHECKS = 1;\n';
  $('#cmp-sql').value = sql;
  renderCmpSummary(diff);
  setStatus('对比完成');
}
function renderCmpSummary(diff) {
  const parts = [
    `<span class="chip add">源独有表 ${diff.tablesAdd.length}</span>`,
    `<span class="chip del">目标独有表 ${diff.tablesDrop.length}</span>`,
    `<span class="chip mod">差异表 ${diff.tableChanges.length}</span>`,
  ];
  if (!diff.tablesAdd.length && !diff.tablesDrop.length && !diff.tableChanges.length) parts.push('<span class="chip add">结构完全一致 ✓</span>');
  if (diff.tablesAdd.length) parts.push(`<div class="cmp-line">源独有表：${escapeHtml(diff.tablesAdd.join(', '))}</div>`);
  if (diff.tablesDrop.length) parts.push(`<div class="cmp-line">目标独有表：${escapeHtml(diff.tablesDrop.join(', '))}</div>`);
  diff.tableChanges.forEach((td) => {
    const bits = [];
    if (td.colsAdd.length) bits.push('+字段 ' + td.colsAdd.map((c) => c.name).join('/'));
    if (td.colsDrop.length) bits.push('-字段 ' + td.colsDrop.join('/'));
    if (td.colsMod.length) bits.push('改字段 ' + td.colsMod.map((c) => c.src.name).join('/'));
    parts.push(`<div class="cmp-line">表 ${escapeHtml(td.table)}：${escapeHtml(bits.join('；'))}</div>`);
  });
  $('#cmp-summary').innerHTML = parts.join('');
}

// ====================== 主题切换 ======================
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  $('#btn-theme').textContent = theme === 'light' ? '☀️' : '🌙';
  $('#btn-theme').title = theme === 'light' ? '切换到深色' : '切换到浅色';
}
function initTheme() { applyTheme(localStorage.getItem('theme') || 'dark'); }
function toggleTheme() {
  const next = (localStorage.getItem('theme') || 'dark') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next); applyTheme(next);
}

// ====================== SQL Dump 导出 ======================
let dumpTarget = { connId: null, database: null, tables: [] };
function openDumpModal(connId, database, tables, title) {
  dumpTarget = { connId, database, tables };
  $('#dump-title').textContent = title;
  $('#dump-structure').checked = true; $('#dump-data').checked = true; $('#dump-drop').checked = true;
  $('#dump-msg').textContent = ''; $('#dump-msg').className = 'modal-msg';
  $('#dump-modal').classList.remove('hidden');
}
async function submitDump() {
  const structure = $('#dump-structure').checked, data = $('#dump-data').checked, drop = $('#dump-drop').checked;
  if (!structure && !data) { $('#dump-msg').textContent = '请至少选择「表结构」或「数据」'; $('#dump-msg').className = 'modal-msg err'; return; }
  $('#dump-msg').textContent = '导出中…'; $('#dump-msg').className = 'modal-msg';
  const res = await window.api.dump({ connId: dumpTarget.connId, database: dumpTarget.database, tables: dumpTarget.tables, structure, data, drop });
  if (res.canceled) { $('#dump-msg').textContent = ''; return; }
  if (!res.ok) { $('#dump-msg').textContent = '导出失败：' + res.error; $('#dump-msg').className = 'modal-msg err'; return; }
  $('#dump-modal').classList.add('hidden');
  toast(`已导出 ${res.tableCount} 张表到 ${res.filePath}`, 'ok');
}

// ====================== 侧栏拖拽 ======================
function initResizer() {
  const rz = $('#sidebar-resizer'), sb = $('#sidebar');
  let dragging = false;
  rz.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => { if (!dragging) return; sb.style.width = Math.max(180, Math.min(520, e.clientX)) + 'px'; });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });

  // 结构树宽度拖拽
  const scRz = $('#schema-resizer'), scPanel = $('#schema-panel');
  const savedScW = localStorage.getItem('schemaWidth'); if (savedScW) scPanel.style.width = savedScW + 'px';
  let scDrag = false;
  scRz.addEventListener('mousedown', (e) => { scDrag = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!scDrag) return;
    const w = Math.max(150, Math.min(420, e.clientX - scPanel.getBoundingClientRect().left));
    scPanel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { if (scDrag) { scDrag = false; localStorage.setItem('schemaWidth', String(Math.round(parseFloat(scPanel.style.width) || 220))); document.body.style.cursor = ''; } });

  // 预览面板宽度拖拽（全局一次性监听）
  window.addEventListener('mousemove', (e) => {
    if (!activePvResize) return;
    const { view, main, pane } = activePvResize;
    if (!main || !pane) return;
    const rect = main.getBoundingClientRect();
    const w = Math.max(220, Math.min(rect.width - 200, rect.right - e.clientX));
    view.previewWidth = w; pane.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!activePvResize) return;
    localStorage.setItem('previewWidth', String(Math.round(activePvResize.view.previewWidth)));
    activePvResize = null; document.body.style.cursor = '';
  });
}

// ====================== 事件绑定 ======================
function bindEvents() {
  $('#btn-new-conn').onclick = () => openModal(null);
  $('#btn-empty-new').onclick = () => openModal(null);
  $('#btn-refresh-tree').onclick = refreshConnections;
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-cancel').onclick = closeModal;
  $('#btn-save').onclick = saveConn;
  $('#btn-test').onclick = testConn;
  $('#btn-row-close').onclick = () => $('#row-modal').classList.add('hidden');
  $('#f-type').onchange = () => {
    const t = $('#f-type').value, p = $('#f-port').value;
    if (!p || p === '3306' || p === '5432') $('#f-port').value = t === 'postgres' ? '5432' : '3306';
    if (t === 'postgres' && $('#f-user').value === 'root') $('#f-user').value = 'postgres';
    if (t !== 'postgres' && $('#f-user').value === 'postgres') $('#f-user').value = 'root';
    applyConnTypeUI();
  };
  $('#btn-pick-db').onclick = async () => {
    const res = await window.api.openFile({ title: '选择 SQLite 数据库文件', filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: '所有文件', extensions: ['*'] }] });
    if (res.ok) { $('#f-sqlite-file').value = res.path; if (!$('#f-name').value.trim()) $('#f-name').value = res.path.split(/[\\/]/).pop(); }
  };

  // 数据导入
  $('#btn-import-data').onclick = () => {
    if (!state.activeConn || !state.data.table) { toast('请先打开一个表的数据', 'err'); return; }
    openImportModal(state.activeConn, state.data.db, state.data.table);
  };
  $('#btn-import-pick').onclick = pickImportFile;
  $('#import-format').onchange = () => { if (state.import && state.import.file) importPreview(); };
  $('#btn-import-cancel').onclick = () => $('#import-modal').classList.add('hidden');
  $('#btn-import-run').onclick = runImport;
  $('#import-modal').addEventListener('click', (e) => { if (e.target.id === 'import-modal') $('#import-modal').classList.add('hidden'); });
  window.api.onImportProgress((d) => {
    if ($('#import-modal').classList.contains('hidden')) return;
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $('#import-fill').style.width = pct + '%';
    $('#import-ptext').textContent = `${d.done} / ${d.total}`;
  });

  $$('.tab').forEach((t) => t.onclick = () => switchTab(t.dataset.tab));

  $('#btn-run').onclick = runQuery;
  $('#btn-format').onclick = formatSql;
  $('#btn-comment').onclick = () => { $('#sql-editor').focus(); toggleComment(); };
  $('#btn-clear-sql').onclick = () => { $('#sql-editor').value = ''; saveActiveQTab(); };
  const ql = $('#query-limit');
  const savedLimit = localStorage.getItem('queryLimit'); if (savedLimit !== null) ql.value = savedLimit;
  ql.onchange = () => localStorage.setItem('queryLimit', ql.value);

  // SQL 片段库
  renderSnippetBar();
  $('#btn-snippets').onclick = toggleSnippetBar;

  // 可视化查询构建器
  $('#btn-qb').onclick = openQueryBuilder;
  $('#qb-db').onchange = qbLoadTables;
  $('#qb-table').onchange = qbLoadColumns;
  $('#qb-col-all').onclick = () => { $('#qb-col-list').querySelectorAll('input').forEach((i) => { i.checked = true; }); qbUpdate(); };
  $('#qb-col-none').onclick = () => { $('#qb-col-list').querySelectorAll('input').forEach((i) => { i.checked = false; }); qbUpdate(); };
  $('#qb-col-list').addEventListener('change', qbUpdate);
  $('#qb-cond-add').onclick = qbAddCond;
  $('#qb-cond-list').addEventListener('input', qbUpdate);
  $('#qb-cond-list').addEventListener('change', qbUpdate);
  $('#qb-cond-list').addEventListener('click', (e) => { if (e.target.classList.contains('qb-c-del')) { e.target.closest('.qb-cond-row').remove(); qbUpdate(); } });
  $('#qb-order').onchange = qbUpdate; $('#qb-order-dir').onchange = qbUpdate; $('#qb-limit').oninput = qbUpdate;
  $('#qb-copy').onclick = async () => { if (!$('#qb-sql').value.trim()) return; await window.api.copy($('#qb-sql').value); toast('已复制 SQL', 'ok'); };
  $('#qb-load').onclick = () => qbApply(false);
  $('#qb-run').onclick = () => qbApply(true);
  $('#qb-close').onclick = () => $('#qb-modal').classList.add('hidden');
  $('#qb-modal').addEventListener('click', (e) => { if (e.target.id === 'qb-modal') $('#qb-modal').classList.add('hidden'); });
  $('#db-select').onchange = () => { saveActiveQTab(); loadSchemaPanel(); };

  // 常驻结构树
  $('#btn-schema').onclick = () => {
    const hidden = $('.query-body').classList.toggle('no-schema');
    localStorage.setItem('schemaHidden', hidden ? '1' : '0');
  };
  if (localStorage.getItem('schemaHidden') === '1') $('.query-body').classList.add('no-schema');
  $('#schema-refresh').onclick = () => { schema.db = null; loadSchemaPanel(); };
  $('#schema-search').oninput = renderSchemaTree;

  // 编辑器：自动补全 + 快捷键
  ac.el = $('#ac');
  const editor = $('#sql-editor');
  editor.addEventListener('input', updateAc);
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); hideAc(); runQuery(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); hideAc(); toggleComment(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !acVisible()) {
      if (jumpToPlaceholder(e.shiftKey)) { e.preventDefault(); return; } // Tab 跳到下一个 «占位符»
    }
    if (acVisible()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; renderAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; renderAc(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acAccept(ac.items[ac.index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
    }
  });
  editor.addEventListener('blur', () => setTimeout(hideAc, 150));
  editor.addEventListener('scroll', hideAc);

  $$('.seg-btn[data-struct]').forEach((b) => b.onclick = () => setStructMode(b.dataset.struct));
  $('#struct-db-select').onchange = onStructDbChange;
  $('#struct-table-select').onchange = loadStructure;

  $('#data-db-select').onchange = onDataDbChange;
  $('#btn-load-data').onclick = () => loadData(true);
  $('#btn-insert-row').onclick = openInsertModal;
  $('#btn-delete-rows').onclick = deleteSelectedRows;
  $('#data-where').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadData(true); });

  $('#btn-insert-cancel').onclick = () => $('#insert-modal').classList.add('hidden');
  $('#btn-insert-save').onclick = submitInsert;

  $('#btn-dump-cancel').onclick = () => $('#dump-modal').classList.add('hidden');
  $('#btn-dump-ok').onclick = submitDump;
  $('#dump-modal').addEventListener('click', (e) => { if (e.target.id === 'dump-modal') $('#dump-modal').classList.add('hidden'); });

  $('#btn-col-cancel').onclick = () => $('#col-modal').classList.add('hidden');
  $('#btn-col-save').onclick = submitColumn;
  $('#col-modal').addEventListener('click', (e) => { if (e.target.id === 'col-modal') $('#col-modal').classList.add('hidden'); });

  $('#btn-idx-cancel').onclick = () => $('#idx-modal').classList.add('hidden');
  $('#btn-idx-save').onclick = submitIndex;
  $('#f-idx-type').onchange = updateIdxNameState;
  $('#idx-modal').addEventListener('click', (e) => { if (e.target.id === 'idx-modal') $('#idx-modal').classList.add('hidden'); });

  $('#btn-fk-cancel').onclick = () => $('#fk-modal').classList.add('hidden');
  $('#btn-fk-save').onclick = submitForeignKey;
  $('#f-fk-rtable').onchange = onFkRefTableChange;
  $('#fk-modal').addEventListener('click', (e) => { if (e.target.id === 'fk-modal') $('#fk-modal').classList.add('hidden'); });

  $('#btn-compare').onclick = openCompareModal;
  $('#cmp-src-conn').onchange = () => fillCmpDbs('src');
  $('#cmp-tgt-conn').onchange = () => fillCmpDbs('tgt');
  $('#btn-cmp-run').onclick = runCompare;
  $('#btn-cmp-copy').onclick = async () => { await window.api.copy($('#cmp-sql').value); toast('已复制同步 SQL', 'ok'); };
  $('#btn-cmp-toquery').onclick = () => { if (!$('#cmp-sql').value.trim()) { toast('请先执行对比', 'err'); return; } $('#sql-editor').value = $('#cmp-sql').value; saveActiveQTab(); $('#cmp-modal').classList.add('hidden'); switchTab('query'); toast('已载入到查询编辑器'); };
  $('#btn-cmp-close').onclick = () => $('#cmp-modal').classList.add('hidden');
  $('#cmp-modal').addEventListener('click', (e) => { if (e.target.id === 'cmp-modal') $('#cmp-modal').classList.add('hidden'); });

  $('#btn-chart-render').onclick = renderChart;
  $('#chart-type').onchange = renderChart;
  $('#btn-chart-close').onclick = () => $('#chart-modal').classList.add('hidden');
  $('#chart-modal').addEventListener('click', (e) => { if (e.target.id === 'chart-modal') $('#chart-modal').classList.add('hidden'); });

  $('#history-filter').oninput = renderHistory;
  $('#btn-history-clear').onclick = async () => { historyCache = await window.api.historyClear(); renderHistory(); toast('已清空历史'); };

  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#row-modal').addEventListener('click', (e) => { if (e.target.id === 'row-modal') $('#row-modal').classList.add('hidden'); });
  $('#insert-modal').addEventListener('click', (e) => { if (e.target.id === 'insert-modal') $('#insert-modal').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('#row-modal').classList.add('hidden'); $('#insert-modal').classList.add('hidden'); $('#dump-modal').classList.add('hidden'); $('#chart-modal').classList.add('hidden'); $('#col-modal').classList.add('hidden'); $('#idx-modal').classList.add('hidden'); $('#fk-modal').classList.add('hidden'); $('#cmp-modal').classList.add('hidden'); $('#import-modal').classList.add('hidden'); $('#qb-modal').classList.add('hidden'); $('#ctx-menu').classList.add('hidden'); } });
}

// ====================== 启动 ======================
initTheme();
bindEvents();
initResizer();
newQTab();
loadSchemaPanel();
refreshConnections();
