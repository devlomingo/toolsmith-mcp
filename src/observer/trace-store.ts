import type { AccessLevel, ErrorCode, JsonValue, ToolSource } from '../core/types.js';
import type { SqlDb } from '../store/db.js';

export interface TraceRecord {
  id: string;
  sessionId: string;
  parentId: string | null;
  tool: string;
  artifactId: string | null;
  source: ToolSource;
  access: AccessLevel;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  errorCode: ErrorCode | null;
  error: string | null;
  upstreamRequests: number;
  retries: number;
  /** Redacted arguments, or null when argument capture is off. */
  args: JsonValue | null;
  argFingerprints: Record<string, string>;
  resultFingerprints: Record<string, string[]>;
  resultBytes: number;
}

export interface TraceQuery {
  sessionId?: string;
  tool?: string;
  since?: number;
  until?: number;
  ok?: boolean;
  /** Only top-level calls (exclude steps inside composites). */
  topLevelOnly?: boolean;
  limit?: number;
  offset?: number;
}

export class TraceStore {
  constructor(private readonly db: SqlDb) {}

  async insert(t: TraceRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO traces (id, session_id, parent_id, tool, artifact_id, source, access, started_at, duration_ms, ok,
          error_code, error, upstream_requests, retries, args, arg_fingerprints, result_fingerprints, result_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.sessionId,
        t.parentId,
        t.tool,
        t.artifactId,
        t.source,
        t.access,
        t.startedAt,
        t.durationMs,
        t.ok ? 1 : 0,
        t.errorCode,
        t.error,
        t.upstreamRequests,
        t.retries,
        t.args === null ? null : JSON.stringify(t.args),
        JSON.stringify(t.argFingerprints),
        JSON.stringify(t.resultFingerprints),
        t.resultBytes,
      ],
    );
  }

  async query(q: TraceQuery = {}): Promise<TraceRecord[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const add = (clause: string, value: string | number): void => {
      where.push(clause);
      params.push(value);
    };
    if (q.sessionId) add('session_id = ?', q.sessionId);
    if (q.tool) add('tool = ?', q.tool);
    if (q.since !== undefined) add('started_at >= ?', q.since);
    if (q.until !== undefined) add('started_at < ?', q.until);
    if (q.ok !== undefined) add('ok = ?', q.ok ? 1 : 0);
    if (q.topLevelOnly) where.push('parent_id IS NULL');
    const sql = `SELECT * FROM traces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    params.push(q.limit ?? 200, q.offset ?? 0);
    return (await this.db.all(sql, params)).map(toTrace);
  }

  /** All top-level traces in chronological order, for pattern mining. */
  async chronological(since?: number): Promise<TraceRecord[]> {
    const rows = await this.db.all(
      `SELECT * FROM traces WHERE parent_id IS NULL ${since !== undefined ? 'AND started_at >= ?' : ''} ORDER BY session_id, started_at, rowid`,
      since !== undefined ? [since] : [],
    );
    return rows.map(toTrace);
  }

  async get(id: string): Promise<TraceRecord | undefined> {
    const r = await this.db.get('SELECT * FROM traces WHERE id = ?', [id]);
    return r ? toTrace(r) : undefined;
  }

  async children(parentId: string): Promise<TraceRecord[]> {
    return (
      await this.db.all('SELECT * FROM traces WHERE parent_id = ? ORDER BY started_at', [parentId])
    ).map(toTrace);
  }

  /** Delete traces older than the retention window. Returns rows removed. */
  async applyRetention(retentionDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - retentionDays * 86_400_000;
    const res = await this.db.run('DELETE FROM traces WHERE started_at < ?', [cutoff]);
    return res.changes;
  }

  async stats(since?: number): Promise<
    Array<{
      tool: string;
      calls: number;
      errors: number;
      avgMs: number;
      p50: number;
      p95: number;
      upstreamRequests: number;
    }>
  > {
    const rows = await this.db.all<{
      tool: string;
      duration_ms: number;
      ok: number;
      upstream_requests: number;
    }>(
      `SELECT tool, duration_ms, ok, upstream_requests FROM traces WHERE parent_id IS NULL ${since ? 'AND started_at >= ?' : ''}`,
      since ? [since] : [],
    );
    const byTool = new Map<string, { d: number[]; errors: number; up: number }>();
    for (const r of rows) {
      const e = byTool.get(r.tool) ?? { d: [], errors: 0, up: 0 };
      e.d.push(r.duration_ms);
      if (!r.ok) e.errors++;
      e.up += r.upstream_requests;
      byTool.set(r.tool, e);
    }
    return [...byTool.entries()]
      .map(([tool, e]) => {
        const sorted = e.d.sort((a, b) => a - b);
        return {
          tool,
          calls: sorted.length,
          errors: e.errors,
          avgMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          upstreamRequests: e.up,
        };
      })
      .sort((a, b) => b.calls - a.calls);
  }

  async count(): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM traces'))!.n);
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function toTrace(r: Record<string, unknown>): TraceRecord {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    parentId: (r.parent_id as string) ?? null,
    tool: String(r.tool),
    artifactId: (r.artifact_id as string) ?? null,
    source: r.source as ToolSource,
    access: r.access as AccessLevel,
    startedAt: Number(r.started_at),
    durationMs: Number(r.duration_ms),
    ok: Number(r.ok) === 1,
    errorCode: (r.error_code as ErrorCode) ?? null,
    error: (r.error as string) ?? null,
    upstreamRequests: Number(r.upstream_requests),
    retries: Number(r.retries),
    args: r.args ? (JSON.parse(String(r.args)) as JsonValue) : null,
    argFingerprints: JSON.parse(String(r.arg_fingerprints)) as Record<string, string>,
    resultFingerprints: JSON.parse(String(r.result_fingerprints)) as Record<string, string[]>,
    resultBytes: Number(r.result_bytes),
  };
}
