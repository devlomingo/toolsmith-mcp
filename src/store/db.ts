import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { silenceSqliteWarning } from './silence.js';

silenceSqliteWarning();
const { DatabaseSync } = await import('node:sqlite');

export type Db = InstanceType<typeof DatabaseSync>;

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

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
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

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
