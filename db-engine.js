/**
 * PFOS SQLite Storage & AES-256-GCM Encryption Engine
 * Stores all financial data strictly in binary SQLite (OPFS + IndexedDB + optional local disk sync).
 * Zero financial data is stored in index.html or localStorage.
 */
const PFOS_DB = (() => {
  const OPFS_FILENAME = 'pfos_vault.sqlite';
  const IDB_NAME = 'pfos_secure_sqlite_vault_v2';
  const IDB_STORE = 'vault_files';
  const IDB_KEY = 'primary_sqlite';
  const MAGIC_HEADER = 'PFOSENC1';

  let SQL = null;
  let db = null;
  let encryptionKey = null;
  let encryptionSalt = null;
  let linkedDiskHandle = null;
  let dbSizeKB = 0;
  let backendLabel = 'OPFS Binary SQLite';

  // ==================== WEB CRYPTO (PBKDF2 + AES-256-GCM) ====================
  async function deriveKey(pin, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(plainBytes) {
    if (!encryptionKey || !encryptionSalt) return plainBytes;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, plainBytes);
    const magic = new TextEncoder().encode(MAGIC_HEADER);
    const out = new Uint8Array(8 + 16 + 12 + cipherBuf.byteLength);
    out.set(magic, 0);
    out.set(encryptionSalt, 8);
    out.set(iv, 24);
    out.set(new Uint8Array(cipherBuf), 36);
    return out;
  }

  function isEncryptedBlob(bytes) {
    if (!bytes || bytes.byteLength < 36) return false;
    return new TextDecoder().decode(bytes.slice(0, 8)) === MAGIC_HEADER;
  }

  async function decryptBytes(blobBytes, pin) {
    const salt = blobBytes.slice(8, 24);
    const iv = blobBytes.slice(24, 36);
    const ciphertext = blobBytes.slice(36);
    const key = await deriveKey(pin, salt);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    encryptionKey = key;
    encryptionSalt = salt;
    return new Uint8Array(plainBuf);
  }

  // ==================== OPFS & INDEXEDDB PERSISTENCE ====================
  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function readStoredBlob() {
    // 1. Origin Private File System (OPFS)
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(OPFS_FILENAME);
        const file = await fh.getFile();
        const buf = await file.arrayBuffer();
        if (buf.byteLength > 0) {
          backendLabel = 'OPFS Binary SQLite';
          return new Uint8Array(buf);
        }
      }
    } catch (_) {}

    // 2. IndexedDB binary store fallback
    try {
      const idb = await openIdb();
      return await new Promise((resolve) => {
        const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => {
          if (req.result) backendLabel = 'IndexedDB Binary SQLite';
          resolve(req.result ? new Uint8Array(req.result) : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  async function writeStoredBlob(rawSqliteBytes) {
    const payload = await encryptBytes(rawSqliteBytes);
    dbSizeKB = Math.max(1, Math.round(payload.byteLength / 1024));

    if (navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(OPFS_FILENAME, { create: true });
        const w = await fh.createWritable();
        await w.write(payload);
        await w.close();
        backendLabel = 'OPFS Binary SQLite';
      } catch (_) {}
    }

    try {
      const idb = await openIdb();
      await new Promise((resolve) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(payload, IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}

    if (linkedDiskHandle) {
      try {
        const w = await linkedDiskHandle.createWritable();
        await w.write(rawSqliteBytes);
        await w.close();
      } catch (err) {
        console.warn('Linked disk write skipped:', err);
      }
    }
  }

  // ==================== RELATIONAL SQLITE SCHEMA ====================
  function createTables(database) {
    database.run(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, profile TEXT, type TEXT, name TEXT, bankName TEXT,
        masked TEXT, ifsc TEXT, balance REAL, creditLimit REAL, statementDay INTEGER,
        dueDay INTEGER, minDue REAL, annualFee REAL, linkedBank TEXT, expiry TEXT, notes TEXT
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, profile TEXT, type TEXT, amount REAL, accountId TEXT,
        toAccountId TEXT, category TEXT, method TEXT, upiApp TEXT, upiId TEXT,
        refNumber TEXT, merchant TEXT, date TEXT, time TEXT, source TEXT,
        isAtm INTEGER, notes TEXT
      );
      CREATE TABLE IF NOT EXISTS loans (
        id TEXT PRIMARY KEY, profile TEXT, direction TEXT, person TEXT,
        principal REAL, outstanding REAL, interest REAL, dueDate TEXT, notes TEXT
      );
      CREATE TABLE IF NOT EXISTS obligations (
        id TEXT PRIMARY KEY, profile TEXT, kind TEXT, title TEXT, amount REAL,
        dueDay INTEGER, remainingMonths INTEGER, frequency TEXT, paidThisMonth INTEGER
      );
      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY, profile TEXT, category TEXT, budgetLimit REAL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, profile TEXT, title TEXT, target REAL, saved REAL, targetDate TEXT
      );
      CREATE TABLE IF NOT EXISTS investments (
        id TEXT PRIMARY KEY, profile TEXT, assetType TEXT, name TEXT,
        invested REAL, currentValue REAL, updated TEXT
      );
      CREATE TABLE IF NOT EXISTS networth_history (
        idx INTEGER PRIMARY KEY, label TEXT, value REAL
      );
    `);
  }

  function queryAll(sql) {
    const res = db.exec(sql);
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map((row) => {
      const obj = {};
      cols.forEach((c, i) => (obj[c] = row[i]));
      return obj;
    });
  }

  function waitForSqlJs(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (typeof window.initSqlJs === 'function') {
          window.initSqlJs({
            locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
          }).then(resolve).catch(reject);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('Timed out loading sql-wasm.js. Check network connection on first launch.'));
        } else {
          setTimeout(check, 80);
        }
      };
      check();
    });
  }

  async function init() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    SQL = await waitForSqlJs();

    const stored = await readStoredBlob();
    if (stored && isEncryptedBlob(stored)) {
      dbSizeKB = Math.max(1, Math.round(stored.byteLength / 1024));
      return { locked: true, encryptedBlob: stored };
    }

    if (stored && stored.byteLength > 0) {
      db = new SQL.Database(stored);
      createTables(db);
      dbSizeKB = Math.max(1, Math.round(stored.byteLength / 1024));
      return { locked: false, isNew: false };
    }

    db = new SQL.Database();
    createTables(db);
    return { locked: false, isNew: true };
  }

  async function unlockWithPin(encryptedBlob, pin) {
    const plainBytes = await decryptBytes(encryptedBlob, pin);
    db = new SQL.Database(plainBytes);
    createTables(db);
    dbSizeKB = Math.max(1, Math.round(encryptedBlob.byteLength / 1024));
  }

  async function enableEncryption(pin) {
    encryptionSalt = crypto.getRandomValues(new Uint8Array(16));
    encryptionKey = await deriveKey(pin, encryptionSalt);
    await persist();
  }

  async function disableEncryption() {
    encryptionKey = null;
    encryptionSalt = null;
    await persist();
  }

  async function persist() {
    if (!db) return;
    await writeStoredBlob(db.export());
  }

  async function saveState(st) {
    if (!db) return;
    db.run('BEGIN TRANSACTION;');
    try {
      ['meta', 'accounts', 'transactions', 'loans', 'obligations', 'budgets', 'goals', 'investments', 'networth_history']
        .forEach((t) => db.run(`DELETE FROM ${t};`));

      const m = db.prepare('INSERT INTO meta VALUES (?, ?)');
      m.run(['activeProfile', st.activeProfile || 'ALL']);
      m.run(['reconciliation', JSON.stringify(st.reconciliation || { dailyReviewDates: [], missedPayments90d: 0 })]);
      m.free();

      const aStmt = db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      (st.accounts || []).forEach((a) => aStmt.run([
        a.id, a.profile || 'PERSONAL', a.type, a.name, a.bankName || '', a.masked || '', a.ifsc || '',
        Number(a.balance || 0), Number(a.creditLimit || 0), a.statementDay || 15, a.dueDay || 5,
        Number(a.minDue || 0), Number(a.annualFee || 0), a.linkedBank || '', a.expiry || '', a.notes || ''
      ]));
      aStmt.free();

      const tStmt = db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      (st.transactions || []).forEach((t) => tStmt.run([
        t.id, t.profile || 'PERSONAL', t.type, Number(t.amount || 0), t.accountId, t.toAccountId || null,
        t.category || '', t.method || 'UPI', t.upiApp || '', t.upiId || '', t.refNumber || '',
        t.merchant || '', t.date || '', t.time || '12:00', t.source || 'MANUAL', t.isAtm ? 1 : 0, t.notes || ''
      ]));
      tStmt.free();

      const lStmt = db.prepare('INSERT INTO loans VALUES (?,?,?,?,?,?,?,?,?)');
      (st.loans || []).forEach((l) => lStmt.run([
        l.id, l.profile || 'PERSONAL', l.direction, l.person, Number(l.principal || 0),
        Number(l.outstanding || 0), Number(l.interest || 0), l.dueDate || '', l.notes || ''
      ]));
      lStmt.free();

      const oStmt = db.prepare('INSERT INTO obligations VALUES (?,?,?,?,?,?,?,?,?)');
      (st.obligations || []).forEach((o) => oStmt.run([
        o.id, o.profile || 'PERSONAL', o.kind, o.title, Number(o.amount || 0),
        Number(o.dueDay || 1), o.remainingMonths != null ? Number(o.remainingMonths) : null,
        o.frequency || 'MONTHLY', o.paidThisMonth ? 1 : 0
      ]));
      oStmt.free();

      const bStmt = db.prepare('INSERT INTO budgets VALUES (?,?,?,?)');
      (st.budgets || []).forEach((b) => bStmt.run([b.id, b.profile || 'PERSONAL', b.category, Number(b.limit || 0)]));
      bStmt.free();

      const gStmt = db.prepare('INSERT INTO goals VALUES (?,?,?,?,?,?)');
      (st.goals || []).forEach((g) => gStmt.run([
        g.id, g.profile || 'PERSONAL', g.title, Number(g.target || 0), Number(g.saved || 0), g.targetDate || ''
      ]));
      gStmt.free();

      const iStmt = db.prepare('INSERT INTO investments VALUES (?,?,?,?,?,?,?)');
      (st.investments || []).forEach((i) => iStmt.run([
        i.id, i.profile || 'PERSONAL', i.assetType, i.name, Number(i.invested || 0),
        Number(i.currentValue || 0), i.updated || ''
      ]));
      iStmt.free();

      const nStmt = db.prepare('INSERT INTO networth_history VALUES (?,?,?)');
      (st.netWorthHistory || []).forEach((h, idx) => nStmt.run([idx, h.label, Number(h.value || 0)]));
      nStmt.free();

      db.run('COMMIT;');
      await persist();
    } catch (err) {
      db.run('ROLLBACK;');
      throw err;
    }
  }

  function loadState() {
    const meta = {};
    queryAll('SELECT key, value FROM meta').forEach((r) => (meta[r.key] = r.value));
    return {
      activeProfile: meta.activeProfile || 'ALL',
      reconciliation: meta.reconciliation ? JSON.parse(meta.reconciliation) : { dailyReviewDates: [], missedPayments90d: 0 },
      accounts: queryAll('SELECT * FROM accounts'),
      transactions: queryAll('SELECT * FROM transactions').map((t) => ({ ...t, isAtm: !!t.isAtm })),
      loans: queryAll('SELECT * FROM loans'),
      obligations: queryAll('SELECT * FROM obligations').map((o) => ({ ...o, paidThisMonth: !!o.paidThisMonth })),
      budgets: queryAll('SELECT id, profile, category, budgetLimit AS "limit" FROM budgets'),
      goals: queryAll('SELECT * FROM goals'),
      investments: queryAll('SELECT * FROM investments'),
      netWorthHistory: queryAll('SELECT label, value FROM networth_history ORDER BY idx ASC')
    };
  }

  function exportRawSqlite() {
    return db ? db.export() : null;
  }

  async function importRawSqlite(bytes) {
    if (isEncryptedBlob(bytes)) {
      throw new Error('This file is AES-encrypted. Decrypt it first or export an unencrypted .sqlite copy.');
    }
    const candidate = new SQL.Database(bytes);
    createTables(candidate);
    db = candidate;
    await persist();
    return loadState();
  }

  async function linkDiskFile() {
    if (!window.showSaveFilePicker) return false;
    linkedDiskHandle = await window.showSaveFilePicker({
      suggestedName: OPFS_FILENAME,
      types: [{ description: 'SQLite Database', accept: { 'application/x-sqlite3': ['.sqlite', '.db'] } }]
    });
    await persist();
    return true;
  }

  function lockInMemory() {
    if (db) {
      try { db.close(); } catch (_) {}
      db = null;
    }
    encryptionKey = null;
    encryptionSalt = null;
  }

  return {
    init, unlockWithPin, enableEncryption, disableEncryption, lockInMemory,
    saveState, loadState, exportRawSqlite, importRawSqlite, linkDiskFile,
    getStats: () => ({
      sizeKB: dbSizeKB,
      backend: backendLabel,
      encrypted: !!encryptionKey,
      diskLinked: !!linkedDiskHandle,
      ready: !!db
    })
  };
})();
