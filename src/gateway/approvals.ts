import { createHash, randomUUID } from 'node:crypto';
import { ToolsmithError } from '../core/errors.js';
import type { JsonObject, JsonValue } from '../core/types.js';
import { stableStringify } from '../registry/registry.js';
import type { Redactor } from '../security/redact.js';
import { nowIso, transaction, type Db } from '../store/db.js';

export interface CallApproval {
  id: string;
  tool: string;
  argsHash: string;
  args: JsonValue;
  sessionId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'used';
  createdAt: string;
  decidedAt: string | null;
  actor: string | null;
}

/**
 * Per-call approval for destructive operations. An approval is bound to the
 * exact tool and arguments (by hash) and is single-use, so approving "delete
 * order 17" can never be replayed as "delete order 18".
 */
export class CallApprovals {
  constructor(
    private readonly db: Db,
    private readonly redactor: Redactor,
  ) {}

  static hashArgs(tool: string, args: JsonObject): string {
    return createHash('sha256')
      .update(`${tool}\n${stableStringify(args)}`)
      .digest('hex');
  }

  /**
   * Consume an approved approval for this exact call, if one exists. It must
   * have been requested by the same session, so one agent cannot spend an
   * approval a human granted to another.
   */
  consume(tool: string, args: JsonObject, sessionId: string, approvalId?: string): boolean {
    const hash = CallApprovals.hashArgs(tool, args);
    return transaction(this.db, () => {
      const row = (
        approvalId
          ? this.db
              .prepare(
                "SELECT id FROM call_approvals WHERE id = ? AND tool = ? AND args_hash = ? AND status = 'approved' AND (session_id IS NULL OR session_id = ?)",
              )
              .get(approvalId, tool, hash, sessionId)
          : this.db
              .prepare(
                "SELECT id FROM call_approvals WHERE tool = ? AND args_hash = ? AND status = 'approved' AND (session_id IS NULL OR session_id = ?) ORDER BY created_at LIMIT 1",
              )
              .get(tool, hash, sessionId)
      ) as { id: string } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE call_approvals SET status = 'used' WHERE id = ?").run(row.id);
      return true;
    });
  }

  /** Create (or reuse) a pending request for this exact call. */
  request(tool: string, args: JsonObject, sessionId: string): CallApproval {
    const hash = CallApprovals.hashArgs(tool, args);
    const existing = this.db
      .prepare(
        "SELECT * FROM call_approvals WHERE tool = ? AND args_hash = ? AND status = 'pending' AND session_id = ?",
      )
      .get(tool, hash, sessionId) as Record<string, unknown> | undefined;
    if (existing) return toApproval(existing);
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        'INSERT INTO call_approvals (id, tool, args_hash, args, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        tool,
        hash,
        JSON.stringify(this.redactor.redact(args)),
        sessionId,
        'pending',
        nowIso(),
      );
    return this.get(id)!;
  }

  decide(id: string, approve: boolean, actor: string): CallApproval {
    const res = this.db
      .prepare(
        "UPDATE call_approvals SET status = ?, decided_at = ?, actor = ? WHERE id = ? AND status = 'pending'",
      )
      .run(approve ? 'approved' : 'rejected', nowIso(), actor, id);
    if (Number(res.changes) === 0)
      throw new ToolsmithError(
        `No pending approval with id ${id}`,
        'not_found',
        'List pending ones with `toolsmith-mcp list`.',
      );
    return this.get(id)!;
  }

  get(id: string): CallApproval | undefined {
    const r = this.db.prepare('SELECT * FROM call_approvals WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? toApproval(r) : undefined;
  }

  list(status?: CallApproval['status']): CallApproval[] {
    const rows = (
      status
        ? this.db
            .prepare(
              'SELECT * FROM call_approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200',
            )
            .all(status)
        : this.db.prepare('SELECT * FROM call_approvals ORDER BY created_at DESC LIMIT 200').all()
    ) as Record<string, unknown>[];
    return rows.map(toApproval);
  }
}

function toApproval(r: Record<string, unknown>): CallApproval {
  return {
    id: String(r.id),
    tool: String(r.tool),
    argsHash: String(r.args_hash),
    args: JSON.parse(String(r.args)) as JsonValue,
    sessionId: (r.session_id as string) ?? null,
    status: r.status as CallApproval['status'],
    createdAt: String(r.created_at),
    decidedAt: (r.decided_at as string) ?? null,
    actor: (r.actor as string) ?? null,
  };
}
