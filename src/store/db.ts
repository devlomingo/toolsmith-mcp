import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mutex } from '../core/mutex.js';
import { silenceSqliteWarning } from './silence.js';

silenceSqliteWarning();
const { DatabaseSync } = await import('node:sqlite');

type Sqlite = InstanceType<typeof DatabaseSync>;
type SqliteParam = null | number | bigint | string | NodeJS.ArrayBufferView;

/**
 * The storage interface every component talks to. SQL uses `?` placeholders
 * and syntax both SQLite and PostgreSQL accept, so another dialect only needs
 * its own implementation of this interface.
 */
export interface SqlDb {
  readonly dialect: 'sqlite' | 'postgres';
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Run fn atomically. Queries inside fn MUST use the `tx` handle passed in. */
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('openapi', 'composite', 'upstream')),
    name TEXT NOT NULL UNIQUE,
    published_version INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE artifact_versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    definition TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    permissions TEXT NOT NULL,
    evaluation TEXT,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
  CREATE TABLE lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    tool TEXT NOT NULL,
    artifact_id TEXT,
    source TEXT NOT NULL,
    access TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    ok INTEGER NOT NULL,
    error_code TEXT,
    error TEXT,
    upstream_requests INTEGER NOT NULL,
    retries INTEGER NOT NULL,
    args TEXT,
    arg_fingerprints TEXT NOT NULL,
    result_fingerprints TEXT NOT NULL,
    result_bytes INTEGER NOT NULL
  );
  CREATE INDEX traces_session ON traces(session_id, started_at);
  CREATE INDEX traces_tool ON traces(tool, started_at);
  CREATE INDEX traces_started ON traces(started_at);
  CREATE TABLE capability_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    request TEXT NOT NULL,
    verdict TEXT NOT NULL,
    analysis TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE call_approvals (
    id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    args TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
    created_at TEXT NOT NULL,
    decided_at TEXT,
    actor TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export function openDb(path: string): SqliteDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return new SqliteDb(db);
}

function migrate(db: Sqlite): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as
    { version: number } | undefined;
  let current = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      current += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(current);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * SQLite over one shared node:sqlite connection. A transaction spans awaits,
 * and any statement run on the connection meanwhile would join it (and be
 * rolled back with it), so every top-level statement and every transaction
 * takes the same lock. Only the `tx` handle passed to a transaction's fn
 * bypasses it.
 */
export class SqliteDb implements SqlDb {
  readonly dialect = 'sqlite' as const;
  private readonly lock = new Mutex();

  constructor(private readonly db: Sqlite) {}

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.locked(() => this.db.prepare(sql).all(...(params as SqliteParam[])) as T[]);
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.locked(
      () => this.db.prepare(sql).get(...(params as SqliteParam[])) as T | undefined,
    );
  }

  run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.locked(() => runSync(this.db, sql, params));
  }

  async transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    await this.lock.acquire();
    const tx = new SqliteTx(this.db);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(tx);
        this.db.exec('COMMIT');
        return out;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } finally {
      tx.end();
      this.lock.release();
    }
  }

  close(): Promise<void> {
    return this.locked(() => this.db.close());
  }

  private locked<T>(fn: () => T): Promise<T> {
    return this.lock.run(fn);
  }
}

/** The handle a transaction's fn runs on: the connection, without the lock. */
class SqliteTx implements SqlDb {
  readonly dialect = 'sqlite' as const;
  private ended = false;

  constructor(private readonly db: Sqlite) {}

  /** A handle kept past its transaction would run statements outside the lock. */
  end(): void {
    this.ended = true;
  }

  private conn(): Sqlite {
    if (this.ended) throw new Error('Transaction handle used after the transaction ended');
    return this.db;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.conn()
      .prepare(sql)
      .all(...(params as SqliteParam[])) as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return this.conn()
      .prepare(sql)
      .get(...(params as SqliteParam[])) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return runSync(this.conn(), sql, params);
  }

  /** Already atomic: nested transactions run inside the outer one. */
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    this.conn();
    return fn(this);
  }

  async close(): Promise<void> {
    throw new Error('Close the database, not a transaction handle');
  }
}

function runSync(db: Sqlite, sql: string, params: unknown[]): { changes: number } {
  const res = db.prepare(sql).run(...(params as SqliteParam[]));
  return { changes: Number(res.changes) };
}

export function nowIso(): string {
  return new Date().toISOString();
}
