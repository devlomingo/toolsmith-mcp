import pg from 'pg';
import { assertNotInTransaction, runInTransaction, type SqlDb } from './db.js';

/**
 * PostgreSQL storage, for several gateway nodes sharing one database. The
 * same SQL as SQLite (`?` placeholders, portable syntax) is rewritten to
 * `$n` here. Transactions run SERIALIZABLE and are retried on serialization
 * failures, so check-then-write sequences (next version number, approval
 * consumption) stay correct when two nodes race. Transaction bodies only
 * touch the database, which is what makes retrying them safe.
 */

// BIGINT columns hold millisecond timestamps and counters, well inside 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

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
    id BIGSERIAL PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE traces (
    seq BIGSERIAL UNIQUE,
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    tool TEXT NOT NULL,
    artifact_id TEXT,
    source TEXT NOT NULL,
    access TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    duration_ms DOUBLE PRECISION NOT NULL,
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
    id BIGSERIAL PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

/**
 * `?` → `$1, $2, …`. Skips string literals ('…', with '' and, in E'…',
 * backslash escapes), quoted identifiers, dollar-quoted strings and
 * comments. A literal `?` operator (jsonb) is written `??`.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]!;
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      const escapes =
        ch === "'" &&
        /[eE]$/.test(sql.slice(0, i)) &&
        !/\w[eE]$/.test(sql.slice(Math.max(0, i - 2), i));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '$' && /^\$[A-Za-z_]*\$/.test(rest)) {
      const tag = /^\$[A-Za-z_]*\$/.exec(rest)![0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '?' && sql[i + 1] === '?') {
      out += '?';
      i += 2;
    } else if (ch === '?') {
      out += `$${++n}`;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Serialization failure and deadlock: retry. A unique violation can come
// from two nodes creating the same row (the retry re-reads and finds the
// winner's), but also from a real bug, so it gets one retry only.
const RETRYABLE = new Set(['40001', '40P01']);
const UNIQUE_VIOLATION = '23505';
const MAX_ATTEMPTS = 8;

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

async function q(c: Queryable, sql: string, params: unknown[]): Promise<pg.QueryResult> {
  return c.query(toPgPlaceholders(sql), params as unknown[]);
}

class PgHandle implements SqlDb {
  readonly dialect = 'postgres' as const;
  constructor(protected readonly c: Queryable) {}

  /** Overridden by the top-level handle to refuse use from inside a transaction. */
  protected check(): void {}

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.check();
    return (await q(this.c, sql, params)).rows as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    this.check();
    return (await q(this.c, sql, params)).rows[0] as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    this.check();
    return { changes: (await q(this.c, sql, params)).rowCount ?? 0 };
  }

  /** Already inside a transaction: nested calls join it. */
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class PostgresDb extends PgHandle {
  constructor(private readonly pool: pg.Pool) {
    super(pool);
  }

  protected override check(): void {
    assertNotInTransaction(this);
  }

  override async transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    assertNotInTransaction(this);
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      // A checked-out client is outside the pool's error handling: without a
      // listener, a dropped connection would crash the process.
      let broken: Error | undefined;
      const onError = (err: Error): void => {
        broken = err;
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const out = await runInTransaction(this, () => fn(new PgHandle(client)));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch((e: Error) => {
          broken ??= e;
        });
        const code = (err as { code?: string }).code;
        const retry =
          !broken &&
          code !== undefined &&
          (RETRYABLE.has(code) ? attempt < MAX_ATTEMPTS : code === UNIQUE_VIOLATION && attempt < 2);
        if (!retry) throw err;
        await new Promise((r) => setTimeout(r, Math.random() * 10 * attempt));
      } finally {
        client.off('error', onError);
        // A broken connection is destroyed, not handed back to the pool.
        client.release(broken);
      }
    }
  }

  override close(): Promise<void> {
    return this.pool.end();
  }
}

export async function openPostgres(url: string, poolSize = 10): Promise<PostgresDb> {
  const pool = new pg.Pool({ connectionString: url, max: poolSize });
  // An idle client that loses its connection must not crash the process.
  pool.on('error', (err) => process.stderr.write(`[toolsmith] postgres: ${err.message}\n`));
  const db = new PostgresDb(pool);
  try {
    await migrate(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }
  return db;
}

async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // One node migrates at a time; the others wait, then see it done.
    await client.query('SELECT pg_advisory_lock(7420)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_version');
    let current = rows[0]?.version ?? 0;
    if (!rows[0]) await client.query('INSERT INTO schema_version (version) VALUES (0)');
    while (current < MIGRATIONS.length) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[current]!);
        current += 1;
        await client.query('UPDATE schema_version SET version = $1', [current]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7420)').catch(() => undefined);
    client.release();
  }
}
