# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Electron desktop database client (dark/light, Chinese UI). Despite the name "MySQL Client", it supports **MySQL / MariaDB / PostgreSQL / SQLite** through a driver abstraction layer. All DB drivers are pure JS (mysql2, pg, sql.js/WASM) — no native compilation. Comments, UI strings, and commit-facing text are in Chinese; match that when editing.

## Commands

```bash
npm install       # first-time deps (downloads Electron)
npm start         # run the app
npm run dev       # run with DevTools open (adds --dev)
npm run smoke     # headless smoke test — the only automated test
npm run icon      # regenerate build/icon.ico, build/icon.png, src/icon.png (pure JS)
npm run pack      # unpacked build → release/win-unpacked/
npm run dist      # NSIS installer → release/MySQLClient-Setup-<version>.exe
```

There is no lint step and no unit-test framework. **`npm run smoke` is the test.** It loads the real `index.html` in a hidden Electron window, exercises renderer functions and IPC against synthetic data, and fails on any `console.error`, preload error, or render-process crash. When you add or change renderer behavior, add an assertion to the object returned inside `scripts/smoke.js` — it drives many internal functions directly (e.g. `renderTree`, `diffSchema`, `openChartModal`), so those must stay reachable as globals.

## Architecture

Standard Electron three-process split under `src/`:

- **`main/main.js`** — main process. Owns all IPC handlers, active connections (`pools` Map: `connId → { type, raw, driver }`), config/history persistence, native dialogs, SQL dump, and import parsing.
- **`main/drivers.js`** — the key abstraction. `createDriver(type)` returns a uniform driver object; see below.
- **`preload/preload.js`** — contextIsolation bridge. Exposes `window.api.*`, each method a thin `ipcRenderer.invoke(channel, ...)`. Every new IPC channel must be wired here to be callable from the renderer.
- **`renderer/`** — `index.html` + `styles.css` + `renderer.js`. Vanilla JS, no framework, no build step. One global `state` object, a `ResultView` class for the reusable result grid, and many top-level functions.

### Driver abstraction (the load-bearing pattern)

`main.js` is mostly DB-agnostic: handlers call `w.driver.<method>(w.raw, ...)` and never assume a dialect. Each driver (`mysqlDriver`, `pgDriver`, `sqliteDriver`) implements the same interface — `connect/end/version/databases/tables/columns/indexesRaw/query/browse/ddl/updateCell/insert/del/schemaSnapshot/importSql/begin/commit/rollback/run/exec` — plus:

- **`q`** — the identifier-quoting function for that dialect (backticks for MySQL, double-quotes for pg/SQLite). Use `w.driver.q(...)`, not a hardcoded quote, in generic code.
- **`caps`** — `{ alter, dump, fk, index, ddlNative }` capability flags. Advanced visual DDL (ALTER column, index/FK editing, SQL dump) is **MySQL/MariaDB only**; those handlers check `w.driver.caps.<x>` and throw a "用 SQL" message otherwise. The renderer hides the corresponding UI via `connCaps()`. When adding a dialect-specific feature, gate it on a cap, don't branch on `type`.
- **`importSql({...})`** — each driver builds its own conflict clause (`INSERT IGNORE`/`ON DUPLICATE KEY`, `ON CONFLICT`, `INSERT OR IGNORE/REPLACE`).

The exception: MySQL-specific DDL and dump code in `main.js` (column/index/FK ops, `db:dump`) uses the module-level `ident()` (backtick quoting) directly rather than the driver's `q`, because those paths are guarded by caps and only ever run for MySQL/MariaDB.

**SQLite specifics:** sql.js loads the whole DB into memory (`raw = { db, file }`). Write operations must call `persist(raw)` to write the in-memory image back to the file. There is one logical database (`main`); `needsFile: true` drives the file-picker UI instead of host/port fields.

**PostgreSQL specifics:** one connection = one database; the tree's "database" level maps to **schemas** within that database (`useDatabase` sets `search_path`).

### IPC conventions

- Handlers are `ipcMain.handle` and return either `{ ok: true, ... }` or `{ ok: false, error: e.message }` (or `{ ok: false, canceled: true }` when a native confirm is declined). Renderer code branches on `r.ok`. Follow this shape for new handlers.
- Destructive actions (drop/truncate table, drop column/index/FK, delete rows) show a **native `dialog.showMessageBox` confirm in the main process** and return `{ canceled: true }` if declined — confirmation lives in main, not the renderer.

### Password security

Passwords are never stored in plaintext and never sent to the renderer:
- Stored via Electron `safeStorage` (Windows DPAPI, bound to the OS account) — `encryptPassword`/`decryptPassword` in `main.js`.
- `sanitize()` strips all password fields before any record goes to the renderer, replacing them with a boolean `hasPassword`.
- On connect/test, `withStoredPassword()` re-injects the decrypted password in the main process only. An empty password field on edit means "keep existing" (`conn:save` preserves the prior encrypted value).
- Legacy plaintext configs are migrated to encrypted form on next save.

### Persistence

Plain JSON in Electron's `userData` dir: `connections.json` (connections) and `sql_history.json` (deduped, capped at 200). Renderer UI state (theme, collapsed groups, preview width) lives in `localStorage`.

## Packaging notes

electron-builder config lives in `package.json`'s `build` block:
- `electronDist` points at the local unpacked Electron to avoid re-download.
- `win.signAndEditExecutable: false` is intentional — resource editing needs `winCodeSign`, whose archive contains macOS symlinks that won't extract on Windows without Developer Mode. Consequence: the exe/shortcut use the default Electron icon (installer icon is still custom via NSIS). Remove this flag only if signing/Developer Mode is set up.
- `sql-wasm.wasm` is in `asarUnpack` so sql.js can read it at runtime.
- First `dist` downloads NSIS (~2 MB) into `.eb-cache/` and reuses it.
