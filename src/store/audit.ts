import type { JsonValue } from '../core/types.js';
import { nowIso, type Db } from './db.js';

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: JsonValue | null;
}

/** Append-only log of administrative actions (imports, approvals, config). */
export class AuditLog {
  constructor(private readonly db: Db) {}

  write(actor: string, action: string, target?: string, detail?: JsonValue): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(nowIso(), actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail));
  }

  list(limit = 200): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      target: (r.target as string) ?? null,
      detail: r.detail ? (JSON.parse(String(r.detail)) as JsonValue) : null,
    }));
  }
}
