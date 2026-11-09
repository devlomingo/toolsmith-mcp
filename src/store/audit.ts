import type { JsonValue } from '../core/types.js';
import { nowIso, type SqlDb } from './db.js';

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
  constructor(private readonly db: SqlDb) {}

  async write(actor: string, action: string, target?: string, detail?: JsonValue): Promise<void> {
    await this.db.run(
      'INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
      [
        nowIso(),
        actor,
        action,
        target ?? null,
        detail === undefined ? null : JSON.stringify(detail),
      ],
    );
  }

  async list(limit = 200): Promise<AuditEntry[]> {
    return (await this.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit])).map(
      (r) => ({
        id: Number(r.id),
        at: String(r.at),
        actor: String(r.actor),
        action: String(r.action),
        target: (r.target as string) ?? null,
        detail: r.detail ? (JSON.parse(String(r.detail)) as JsonValue) : null,
      }),
    );
  }
}
