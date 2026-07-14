// 临时冒烟测试：加载真实 index.html，捕获渲染进程报错并检查 DOM 是否正确渲染
process.env.MYSQL_SMOKE = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../src/main/main.js'); // 注册真实的 IPC 处理器

const errors = [];
let result = null;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push('[console.error] ' + message); // 2=warning,3=error
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('[render-gone] ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, err) => errors.push('[preload-error] ' + err.message));

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  try {
    result = await win.webContents.executeJavaScript(`(async () => { const __conns = await window.api.listConnections(); return {
      treeHasContent: !!(document.querySelector('#tree') && document.querySelector('#tree').innerHTML.trim()),
      apiPresent: typeof window.api === 'object' && typeof window.api.updateCell === 'function' && typeof window.api.dbColumns === 'function',
      // 新建连接弹窗
      modalOpens: (() => { document.querySelector('#btn-new-conn').click(); const ok = !document.querySelector('#modal').classList.contains('hidden'); document.querySelector('#btn-cancel').click(); return ok; })(),
      // 查询标签页：默认应有 1 个 tab + 新建按钮
      qtabCount: document.querySelectorAll('#qtabs .qtab').length,
      qtabAddBtn: !!document.querySelector('#qtab-add'),
      // 新建第二个 tab，应变为 2 个
      qtabAddWorks: (() => { document.querySelector('#qtab-add').click(); return document.querySelectorAll('#qtabs .qtab').length; })(),
      // 自动补全容器、数据编辑按钮、新增行弹窗存在
      acEl: !!document.querySelector('#ac'),
      insertBtn: !!document.querySelector('#btn-insert-row'),
      deleteBtn: !!document.querySelector('#btn-delete-rows'),
      insertModal: !!document.querySelector('#insert-modal'),
      caretFnOk: (() => { try { const co = caretCoords(document.querySelector('#sql-editor'), 0); return typeof co.top === 'number'; } catch(e){ return 'ERR:'+e.message; } })(),
      // 主题切换：点击应切到 light，再点回 dark
      themeToggle: (() => { document.querySelector('#btn-theme').click(); const a = document.documentElement.getAttribute('data-theme'); document.querySelector('#btn-theme').click(); const b = document.documentElement.getAttribute('data-theme'); return a + '->' + (b||'dark'); })(),
      // SQL dump 弹窗 + API
      dumpModal: !!document.querySelector('#dump-modal'),
      dumpApi: typeof window.api.dump === 'function',
      // 密码安全：列表不应携带明文密码或密文字段
      noPlainPw: !__conns.some(c => 'password' in c || 'passwordEnc' in c),
      // 图表：用合成数据渲染柱状图与饼图
      chartSvg: (() => { try {
        openChartModal(['x','y'], [{x:'a',y:1},{x:'b',y:2},{x:'c',y:3}]);
        const bar = !!document.querySelector('#chart-area svg');
        document.querySelector('#chart-type').value = 'pie'; renderChart();
        const pie = !!document.querySelector('#chart-area svg path');
        document.querySelector('#btn-chart-close').click();
        return { bar, pie };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 分组/收藏：注入两个连接（一个分组、一个收藏），应出现 2 个分组头与 1 个 ★
      grouping: (() => { try {
        state.connections = [
          { id:'t1', name:'A', group:'G1', host:'h', user:'u', port:3306 },
          { id:'t2', name:'B', favorite:true, host:'h', user:'u', port:3306 },
        ];
        renderTree();
        return { headers: document.querySelectorAll('#tree .group-header').length, star: !!document.querySelector('#tree .node .star') };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 可编辑表结构：渲染字段列表，校验新增/编辑/删除按钮与字段弹窗
      colApi: typeof window.api.columnOp === 'function',
      structEdit: (() => { try {
        renderStructureColumns('db','t',[
          { name:'id', type:'int', nullable:'NO', key:'PRI', default:null, extra:'auto_increment', comment:'' },
          { name:'nm', type:'varchar(50)', nullable:'YES', key:'', default:null, extra:'', comment:'名称' },
        ]);
        const addBtn = !!document.querySelector('#btn-add-col');
        const editBtns = document.querySelectorAll('#structure-content button[data-act="edit"]').length;
        const dropBtns = document.querySelectorAll('#structure-content button[data-act="drop"]').length;
        document.querySelector('#btn-add-col').click();
        const modalOpen = !document.querySelector('#col-modal').classList.contains('hidden');
        const posShown = document.querySelector('#col-pos-row').style.display !== 'none';
        document.querySelector('#btn-col-cancel').click();
        return { addBtn, editBtns, dropBtns, modalOpen, posShown };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 可编辑索引：渲染 SHOW INDEX 分组，校验新增/删除按钮与主键名称禁用逻辑
      idxApi: typeof window.api.indexOp === 'function',
      indexEdit: (() => { try {
        renderStructureIndexes('db','t',[
          { Key_name:'PRIMARY', Non_unique:0, Seq_in_index:1, Column_name:'id', Index_type:'BTREE' },
          { Key_name:'idx_nm', Non_unique:1, Seq_in_index:1, Column_name:'nm', Index_type:'BTREE' },
        ]);
        const addBtn = !!document.querySelector('#btn-add-idx');
        const dropBtns = document.querySelectorAll('#structure-content button[data-act="drop"]').length;
        const pkShown = document.querySelector('#structure-content tbody').textContent.includes('主键');
        // 主键类型时索引名应禁用
        document.querySelector('#f-idx-type').value = 'PRIMARY'; updateIdxNameState();
        const nameDisabledForPk = document.querySelector('#f-idx-name').disabled;
        document.querySelector('#f-idx-type').value = 'INDEX'; updateIdxNameState();
        const nameEnabledForIdx = !document.querySelector('#f-idx-name').disabled;
        return { addBtn, dropBtns, pkShown, nameDisabledForPk, nameEnabledForIdx };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 多数据库类型：连接弹窗类型下拉（4 项含 SQLite）+ 字段类型改为下拉(datalist)
      typeSelect: document.querySelectorAll('#f-type option').length,
      colTypeDropdown: !!document.querySelector('#col-type-list') && document.querySelector('#f-col-type').getAttribute('list') === 'col-type-list',
      // SQLite：切到 sqlite 时显示文件字段、隐藏服务器字段
      sqliteUI: (() => { try {
        document.querySelector('#btn-new-conn').click();
        document.querySelector('#f-type').value = 'sqlite'; applyConnTypeUI();
        const fileShown = !document.querySelector('#sqlite-fields').classList.contains('hidden');
        const serverHidden = document.querySelector('#server-fields').classList.contains('hidden');
        document.querySelector('#btn-cancel').click();
        return { fileShown, serverHidden };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 数据导入：弹窗 + API + 字段映射构建 + 进度条
      importApi: typeof window.api.importData === 'function' && typeof window.api.importPreview === 'function' && typeof window.api.openFile === 'function',
      importBtn: !!document.querySelector('#btn-import-data'),
      importMapping: (() => { try {
        buildImportMapping([{name:'id',type:'int',key:'PRI'},{name:'name',type:'varchar',key:''}], ['ID','name','extra']);
        const selects = document.querySelectorAll('#import-mapping select[data-target]').length;
        // 自动匹配：name 列应被选中 name
        const nameSel = [...document.querySelectorAll('#import-mapping select[data-target]')].find(s=>s.dataset.target==='name');
        return { selects, autoMatch: nameSel && nameSel.value === 'name', hasBar: !!document.querySelector('#import-fill') };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 外键：渲染 + 新增按钮 + seg 段
      fkApi: typeof window.api.fkOp === 'function',
      fkSeg: !!document.querySelector('.seg-btn[data-struct="fk"]'),
      fkEdit: (() => { try {
        renderStructureForeignKeys('db','t',[{ name:'fk_uid', col:'uid', refTable:'users', refCol:'id', pos:1, onUpdate:'CASCADE', onDelete:'SET NULL' }]);
        return { addBtn: !!document.querySelector('#btn-add-fk'), dropBtns: document.querySelectorAll('#structure-content button[data-act="drop"]').length, refShown: document.querySelector('#structure-content tbody').textContent.includes('users') };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 行预览面板：数据视图渲染后点击某行，预览面板应显示该行内容
      previewPane: (() => { try {
        dataView.setData(['id','nm'], [{ id:1, nm:'alice' }, { id:2, nm:'bob' }], {});
        const hasPane = !!document.querySelector('#data-result .preview-pane');
        const cell = document.querySelector('#data-result tbody tr[data-i="1"] td:not(.rownum)');
        cell.click();
        const pane = document.querySelector('#data-result .preview-pane');
        const shows = pane && pane.textContent.includes('bob');
        const rowHl = !!document.querySelector('#data-result tr.row-preview');
        // 宽度可调：存在拖拽条，且设置 previewWidth 后重渲染生效
        const hasResizer = !!document.querySelector('#data-result .pv-resizer');
        dataView.previewWidth = 420; dataView.render();
        const widthApplied = document.querySelector('#data-result .preview-pane').style.width === '420px';
        return { hasPane, shows: !!shows, rowHl, hasResizer, widthApplied };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 结构对比：API + 弹窗 + diff 算法
      cmpApi: typeof window.api.schemaSnapshot === 'function',
      cmpModal: !!document.querySelector('#cmp-modal'),
      diffCalc: (() => { try {
        const src = { a:[{name:'id',type:'bigint',nullable:'NO',default:null,extra:''},{name:'nm',type:'varchar(50)',nullable:'YES',default:null,extra:''}], onlySrc:[{name:'x',type:'int',nullable:'YES',default:null,extra:''}] };
        const tgt = { a:[{name:'id',type:'int',nullable:'NO',default:null,extra:''}], onlyTgt:[{name:'y',type:'int',nullable:'YES',default:null,extra:''}] };
        const d = diffSchema(src, tgt);
        return { add: d.tablesAdd, drop: d.tablesDrop, changes: d.tableChanges.length, colDef: snapColDef(src.a[1]).includes('varchar(50)') };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 智能查询：多语句切分（忽略字符串/注释中的分号）、光标定位语句
      stmtSplit: (() => { try {
        const twoInString = splitStatements("SELECT ';'; SELECT 2").length; // 字符串里的 ; 不算
        const one = splitStatements("SELECT 1 -- a; b\\n").length;          // 注释里的 ; 不算
        const at = statementAt('SELECT 1; SELECT 2;', 12).text.trim();      // 光标在第二条
        return { twoInString, one, at };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 智能查询：子句上下文推断 + 别名解析
      ctxInfer: (() => { try {
        const data = { tables:['users','orders'], columns:['id','name'], byTable:{ users:['id','name'], orders:['id','amount'] } };
        return {
          afterFrom: clauseContext('SELECT * FROM '),                        // table
          afterWhere: clauseContext('SELECT * FROM users WHERE '),           // column
          afterSelect: clauseContext('SELECT '),                             // column
          aliasResolve: resolveAlias('u', 'SELECT * FROM users u WHERE u.', data), // users
          directTable: resolveAlias('orders', 'SELECT * FROM orders', data), // orders
        };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 智能查询：候选项按上下文排序（column 上下文里字段应排在关键字前）
      acRank: (() => { try {
        const items = [{text:'name',kind:'列'},{text:'NULL',kind:'关键字'}];
        return rankItems(items, 'n', 'column')[0].kind === '列';
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 结果分页：可分页判定 + 子查询包裹 + 计数
      paging: (() => { try {
        return {
          ok: isPaginatable('SELECT * FROM t'), noLimit: !isPaginatable('SELECT * FROM t LIMIT 5'),
          notSelect: !isPaginatable('UPDATE t SET x=1'), multi: !isPaginatable('SELECT 1; SELECT 2'),
          wrap: /SELECT \\* FROM \\(/.test(wrapPaged('SELECT * FROM t', 20, 40)) && /LIMIT 20 OFFSET 40/.test(wrapPaged('SELECT * FROM t', 20, 40)),
          count: /COUNT\\(\\*\\)/.test(wrapCount('SELECT * FROM t')),
        };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 结果分页：翻页器 UI 渲染 + 页码信息
      pagerUI: (() => { try {
        queryView.pager = { offset: 0, pageSize: 20, total: 57, onPage: () => {} };
        queryView.setData(['id'], [{id:1},{id:2}]);
        const host = document.querySelector('#query-result');
        const hasPager = !!host.querySelector('.rt-pager');
        const info = host.querySelector('.pg-info') ? host.querySelector('.pg-info').textContent : '';
        queryView.pager = null; queryView.fetchAll = null;
        return { hasPager, info };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 导出全部：toCSV/toTSV 可接收显式列与行（用于导出完整结果集）
      exportAll: (() => { try {
        const v = new ResultView(document.querySelector('#query-result'), { name:'t' });
        v.setData(['id'], [{id:1}]);
        const csv = v.toCSV(['id'], [{id:1},{id:2},{id:3}]);
        const tsv = v.toTSV(['id'], [{id:1},{id:2}]);
        return { csvLines: csv.split('\\n').length, tsvLines: tsv.split('\\n').length };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 常驻结构树：渲染表/字段、🔑 主键、单击插入
      schemaPanel: (() => { try {
        schema.db = 'db'; schema.tables = ['users','orders']; schema.cols = {}; schema.expanded = new Set();
        document.querySelector('#schema-search').value = '';
        renderSchemaTree();
        const tables = document.querySelectorAll('#schema-tree .sc-table').length;
        schema.expanded.add('users'); schema.cols['users'] = [{name:'id',type:'int',key:'PRI'},{name:'name',type:'varchar(50)',key:''}];
        renderSchemaTree();
        const cols = document.querySelectorAll('#schema-tree .sc-col').length;
        const pk = document.querySelector('#schema-tree .sc-col').textContent.includes('🔑');
        const el = document.querySelector('#sql-editor'); el.value = ''; el.setSelectionRange(0, 0);
        insertText('users');
        return { tables, cols, pk, inserted: el.value === 'users' };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // Tab 在占位符间跳转
      phNav: (() => { try {
        const el = document.querySelector('#sql-editor');
        el.value = 'SELECT «a», «b» FROM t'; el.setSelectionRange(0, 0);
        const f1 = jumpToPlaceholder(false); const sel1 = el.value.slice(el.selectionStart, el.selectionEnd);
        const f2 = jumpToPlaceholder(false); const sel2 = el.value.slice(el.selectionStart, el.selectionEnd);
        return { f1, sel1, f2, sel2 };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 自动补全：候选项带类型/主键信息（注入缓存后 acPool 应带 hint）
      acHint: (() => { try {
        acCache.set(acKey(), { tables:['users'], columns:['id'], byTable:{users:['id']}, meta:{users:{id:{type:'int',key:'PRI'}}}, typeByName:{id:'int'} });
        const item = acPool().find(p => p.text === 'id' && p.kind === '列');
        return { hint: item && item.hint === 'int' };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 智能查询：Ctrl+/ 行注释切换（注释 → 取消注释应还原）
      commentToggle: (() => { try {
        const el = document.querySelector('#sql-editor');
        el.value = 'SELECT 1'; el.setSelectionRange(0, el.value.length);
        toggleComment(); const commented = el.value;
        el.setSelectionRange(0, el.value.length); toggleComment(); const restored = el.value;
        return { commented, restored };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 片段库：渲染出 chip，点击/调用 insertSnippet 后应插入并选中第一个占位符
      snippets: (() => { try {
        renderSnippetBar();
        const chips = document.querySelectorAll('#snippet-bar .snip-chip').length;
        const el = document.querySelector('#sql-editor'); el.value = ''; el.setSelectionRange(0, 0);
        insertSnippet('SELECT * FROM «表»;');
        const inserted = el.value.includes('SELECT * FROM');
        const selPlaceholder = el.value.slice(el.selectionStart, el.selectionEnd) === '«表»';
        return { chips: chips > 0, inserted, selPlaceholder };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 右键表模板：INSERT 跳过自增列、UPDATE 用主键做 WHERE
      genTmpl: (() => { try {
        const cols = [{name:'id',type:'int',key:'PRI',extra:'auto_increment'},{name:'name',type:'varchar(50)',key:'',extra:''}];
        const ins = buildRowTemplate('insert','users',cols,null);
        const upd = buildRowTemplate('update','users',cols,null);
        return {
          insSkipsAuto: !/\`id\`/.test(ins.split('VALUES')[0]) && /\`name\`/.test(ins),
          updWherePk: /WHERE \`id\` = «值»/.test(upd), updSetsName: /\`name\` = «varchar\\(50\\)»/.test(upd),
        };
      } catch(e){ return 'ERR:'+e.message; } })(),
      // 可视化构建器：勾字段 + 条件 + 排序 + 限制 → 生成 SQL
      qbApi: typeof openQueryBuilder === 'function' && !!document.querySelector('#qb-modal'),
      qbBuild: (() => { try {
        qb.table = 'users'; qb.cols = [{name:'id',type:'int'},{name:'name',type:'varchar'}];
        document.querySelector('#qb-col-list').innerHTML =
          '<label><input type="checkbox" value="id" checked></label><label><input type="checkbox" value="name" checked></label>';
        document.querySelector('#qb-cond-list').innerHTML = '';
        qbAddCond();
        const row = document.querySelector('.qb-cond-row');
        row.querySelector('.qb-c-col').value = 'id'; row.querySelector('.qb-c-op').value = '>'; row.querySelector('.qb-c-val').value = '10';
        document.querySelector('#qb-order').innerHTML = '<option value="id">id</option>'; document.querySelector('#qb-order').value = 'id';
        document.querySelector('#qb-order-dir').value = 'DESC'; document.querySelector('#qb-limit').value = '50';
        const sql = qbBuildSql();
        return {
          cols: /SELECT \`id\`, \`name\`/.test(sql), where: /WHERE \`id\` > 10/.test(sql),
          order: /ORDER BY \`id\` DESC/.test(sql), limit: /LIMIT 50;/.test(sql),
        };
      } catch(e){ return 'ERR:'+e.message; } })(),
    }; })()`);
  } catch (e) {
    errors.push('[executeJavaScript] ' + e.message);
  }

  console.log('SMOKE_RESULT=' + JSON.stringify({ result, errors }));
  app.quit();
});
