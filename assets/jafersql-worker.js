/**
 * JaferSQL Worker Helper v1.0.0
 * Offload JaferSQL operations to a Web Worker.
 * MIT License – Copyright (c) 2026 Jafer
 */
(function(global) {
  'use strict';

  // Detect environment
  const isBrowser = typeof window !== 'undefined';

  if (!isBrowser) {
    console.warn('JaferSQLWorker Helper is designed for browser main thread only.');
    return;
  }

  // Message protocol
  const MSG_TYPES = {
    INIT: 'jafersql:init',
    EXEC: 'jafersql:exec',
    RUN: 'jafersql:run',
    GET: 'jafersql:get',
    ALL: 'jafersql:all',
    EXPORT: 'jafersql:export',
    BACKUP: 'jafersql:backup',
    TRANSACTION: 'jafersql:transaction',
    TABLES: 'jafersql:tables',
    VERSION: 'jafersql:version',
    VACUUM: 'jafersql:vacuum',
    IMPORT_SQL: 'jafersql:importSQL',
    EXPORT_JSON: 'jafersql:exportJSON',
    EXPORT_CSV: 'jafersql:exportCSV',
    PRAGMA: 'jafersql:pragma',
    STATS: 'jafersql:stats',
    CLOSE: 'jafersql:close',
    RESULT: 'jafersql:result',
    ERROR: 'jafersql:error',
    PROGRESS: 'jafersql:progress'
  };

  // Default worker script (inline Blob)
  function createWorkerScript(jafersqlPath) {
    // jafersqlPath should be an absolute URL to jafersql.js
    return `
      importScripts('${jafersqlPath}');

      let db = null;
      let transactionDepth = 0;

      // Progress forwarding
      JaferSQL.onProgress((stage, detail) => {
        self.postMessage({ type: '${MSG_TYPES.PROGRESS}', stage, detail });
      });

      self.addEventListener('message', async (e) => {
        const { id, type, payload } = e.data;

        const respond = (result) => {
          self.postMessage({ id, type: '${MSG_TYPES.RESULT}', result });
        };
        const error = (err) => {
          self.postMessage({ id, type: '${MSG_TYPES.ERROR}', error: err.message, stack: err.stack });
        };

        try {
          if (type === '${MSG_TYPES.INIT}') {
            const { source } = payload || {};
            let binary = source;
            if (source && source instanceof ArrayBuffer) {
              binary = new Uint8Array(source);
            }
            db = await JaferSQL.jaferInit(binary);
            respond({ success: true });
          } else if (!db) {
            throw new Error('Database not initialized. Call init() first.');
          } else if (type === '${MSG_TYPES.EXEC}') {
            const result = db.jaferExec(payload.sql);
            respond(result);
          } else if (type === '${MSG_TYPES.RUN}') {
            const result = db.jaferRun(payload.sql, payload.params);
            respond(result);
          } else if (type === '${MSG_TYPES.GET}') {
            const result = db.jaferGet(payload.sql, payload.params);
            respond(result);
          } else if (type === '${MSG_TYPES.ALL}') {
            const result = db.jaferAll(payload.sql, payload.params);
            respond(result);
          } else if (type === '${MSG_TYPES.EXPORT}') {
            const result = db.jaferExport();
            respond(result.buffer.slice(0)); // transferable
          } else if (type === '${MSG_TYPES.BACKUP}') {
            const backup = db.jaferBackup();
            const data = backup.jaferExport();
            backup.jaferClose();
            respond(data.buffer.slice(0));
          } else if (type === '${MSG_TYPES.TRANSACTION}') {
            // Transaction is handled differently: we can't pass a callback across the worker boundary easily.
            // Instead, we'll provide a simpler BEGIN/COMMIT/ROLLBACK manual control.
            // For now, we'll reject; the main thread should use run() for manual transactions.
            throw new Error('Transactions must be managed manually via jaferRun("BEGIN") etc.');
          } else if (type === '${MSG_TYPES.TABLES}') {
            respond(db.jaferTables());
          } else if (type === '${MSG_TYPES.VERSION}') {
            respond(db.jaferVersion());
          } else if (type === '${MSG_TYPES.VACUUM}') {
            db.jaferVacuum();
            respond(null);
          } else if (type === '${MSG_TYPES.IMPORT_SQL}') {
            db.jaferImportSQL(payload.sql);
            respond(null);
          } else if (type === '${MSG_TYPES.EXPORT_JSON}') {
            respond(db.jaferExportJSON(payload.tableOrQuery));
          } else if (type === '${MSG_TYPES.EXPORT_CSV}') {
            respond(db.jaferExportCSV(payload.tableOrQuery, payload.delimiter));
          } else if (type === '${MSG_TYPES.PRAGMA}') {
            respond(db.jaferPragma(payload.name, payload.value));
          } else if (type === '${MSG_TYPES.STATS}') {
            respond(db.jaferStats());
          } else if (type === '${MSG_TYPES.CLOSE}') {
            db.jaferClose();
            db = null;
            respond(null);
          } else {
            throw new Error('Unknown message type: ' + type);
          }
        } catch (err) {
          error(err);
        }
      });

      // Notify ready
      self.postMessage({ type: 'ready' });
    `;
  }

  class JaferSQLWorkerClient {
    constructor(worker, options = {}) {
      this.worker = worker;
      this.ready = false;
      this.readyPromise = new Promise((resolve) => {
        const handler = (e) => {
          if (e.data && e.data.type === 'ready') {
            this.ready = true;
            this.worker.removeEventListener('message', handler);
            resolve();
          }
        };
        this.worker.addEventListener('message', handler);
      });
      this._pending = new Map();
      this._nextId = 1;

      // Listen for responses and errors
      this.worker.addEventListener('message', (e) => {
        const { id, type, result, error, stack, stage, detail } = e.data;
        if (type === MSG_TYPES.PROGRESS) {
          if (options.onProgress) {
            options.onProgress(stage, detail);
          }
          return;
        }
        if (id && this._pending.has(id)) {
          const { resolve, reject } = this._pending.get(id);
          this._pending.delete(id);
          if (type === MSG_TYPES.RESULT) {
            // If result is an ArrayBuffer, convert back to Uint8Array
            if (result instanceof ArrayBuffer) {
              resolve(new Uint8Array(result));
            } else {
              resolve(result);
            }
          } else if (type === MSG_TYPES.ERROR) {
            reject(new Error(error + (stack ? '\n' + stack : '')));
          }
        }
      });
    }

    async _send(type, payload = null, transferables = []) {
      await this.readyPromise;
      return new Promise((resolve, reject) => {
        const id = this._nextId++;
        this._pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, type, payload }, transferables);
      });
    }

    async init(source = null) {
      let transferables = [];
      let payload = {};
      if (source instanceof Uint8Array) {
        payload.source = source.buffer;
        transferables = [source.buffer];
      } else if (source instanceof ArrayBuffer) {
        payload.source = source;
        transferables = [source];
      }
      return this._send(MSG_TYPES.INIT, payload, transferables);
    }

    async exec(sql) {
      return this._send(MSG_TYPES.EXEC, { sql });
    }

    async run(sql, params = []) {
      return this._send(MSG_TYPES.RUN, { sql, params });
    }

    async get(sql, params = []) {
      return this._send(MSG_TYPES.GET, { sql, params });
    }

    async all(sql, params = []) {
      return this._send(MSG_TYPES.ALL, { sql, params });
    }

    async export() {
      return this._send(MSG_TYPES.EXPORT);
    }

    async backup() {
      return this._send(MSG_TYPES.BACKUP);
    }

    async tables() {
      return this._send(MSG_TYPES.TABLES);
    }

    async version() {
      return this._send(MSG_TYPES.VERSION);
    }

    async vacuum() {
      return this._send(MSG_TYPES.VACUUM);
    }

    async importSQL(sqlString) {
      return this._send(MSG_TYPES.IMPORT_SQL, { sql: sqlString });
    }

    async exportJSON(tableOrQuery) {
      return this._send(MSG_TYPES.EXPORT_JSON, { tableOrQuery });
    }

    async exportCSV(tableOrQuery, delimiter = ',') {
      return this._send(MSG_TYPES.EXPORT_CSV, { tableOrQuery, delimiter });
    }

    async pragma(name, value) {
      return this._send(MSG_TYPES.PRAGMA, { name, value });
    }

    async stats() {
      return this._send(MSG_TYPES.STATS);
    }

    async close() {
      return this._send(MSG_TYPES.CLOSE);
    }

    terminate() {
      this.worker.terminate();
    }
  }

  // Public API
  const JaferSQLWorker = {
    /**
     * Create a new worker and return a promise that resolves to a client instance.
     * @param {object} options
     * @param {string} [options.jafersqlPath] - URL to jafersql.js (default: 'jafersql.js')
     * @param {function} [options.onProgress] - progress callback
     * @returns {Promise<JaferSQLWorkerClient>}
     */
    create: function(options = {}) {
      const jafersqlPath = options.jafersqlPath || 'jafersql.js';
      const workerCode = createWorkerScript(jafersqlPath);
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      // Optional: revoke URL after worker loads? Not necessary.
      const client = new JaferSQLWorkerClient(worker, options);
      // Auto-initialize? No, user calls init() explicitly.
      return Promise.resolve(client);
    },

    /**
     * Convenience: create and initialize in one call.
     * @param {Uint8Array|ArrayBuffer|null} source - existing DB binary
     * @param {object} options
     * @returns {Promise<JaferSQLWorkerClient>}
     */
    createAndInit: async function(source = null, options = {}) {
      const client = await this.create(options);
      await client.init(source);
      return client;
    }
  };

  // Expose
  global.JaferSQLWorker = JaferSQLWorker;

})(typeof window !== 'undefined' ? window : global);