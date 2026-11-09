import { createHash, randomUUID } from 'node:crypto';
import { ToolsmithError } from '../core/errors.js';
import type { JsonValue } from '../core/types.js';
import { nowIso, type SqlDb } from '../store/db.js';

export const STATUSES = [
  'discovered',
  'proposed',
  'generating',
  'testing',
  'awaiting_approval',
  'approved',
  'published',
  'disabled',
  'rejected',
  'failed',
] as const;
export type Status = (typeof STATUSES)[number];

export type ArtifactKind = 'openapi' | 'composite' | 'upstream';

/**
 * Allowed lifecycle moves. Anything else is refused, so nothing reaches
 * `published` without passing `awaiting_approval` -> `approved`, which only a
 * human actor can perform.
 */
const TRANSITIONS: Record<Status, Status[]> = {
  discovered: ['proposed', 'rejected'],
  proposed: ['generating', 'rejected'],
  generating: ['testing', 'failed'],
  testing: ['awaiting_approval', 'failed'],
  awaiting_approval: ['approved', 'rejected', 'generating'],
  approved: ['published', 'disabled', 'rejected'],
  // published -> approved happens when a newer version supersedes it; the old
  // version stays approved so rollback can publish it again.
  published: ['disabled', 'approved'],
  disabled: ['published', 'rejected'],
  rejected: [],
  failed: ['generating', 'rejected'],
};

export interface Permissions {
  allowWrite: boolean;
  allowDestructive: boolean;
  /**
   * Description written by the approving human; replaces the generated one
   * (composites). Stored with the approval because the definition itself is
   * content-hashed and immutable.
   */
  description?: string;
}

export interface Evaluation {
  passed: boolean;
  ranAt: string;
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
    severity?: 'info' | 'warning' | 'error';
  }>;
  metrics?: Record<string, number>;
}

export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  name: string;
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRow {
  artifactId: string;
  version: number;
  status: Status;
  definition: JsonValue;
  contentHash: string;
  permissions: Permissions;
  evaluation: Evaluation | null;
  origin: string;
  createdAt: string;
}

export interface LifecycleEvent {
  artifactId: string;
  version: number;
  fromStatus: Status | null;
  toStatus: Status;
  actor: string;
  reason: string | null;
  at: string;
}

/** Actors that represent a human decision (CLI user or dashboard admin). */
export function isHumanActor(actor: string): boolean {
  return actor.startsWith('human:');
}

const HUMAN_ONLY: Status[] = ['approved'];

export class Registry {
  private listeners = new Set<() => void | Promise<void>>();

  constructor(private readonly db: SqlDb) {}

  /** Listeners run after each catalog change and are awaited by the change. */
  onChange(fn: () => void | Promise<void>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run fn on a view of this registry bound to one transaction. */
  private atomically<T>(fn: (r: Registry) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Registry(tx)));
  }

  /** Monotonic counter other processes poll to notice catalog changes. */
  async revision(): Promise<number> {
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'catalog_rev'",
    );
    return row ? Number(row.value) : 0;
  }

  private async bump(): Promise<void> {
    await this.db.run(
      "INSERT INTO settings (key, value) VALUES ('catalog_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)",
    );
    for (const fn of this.listeners) await fn();
  }

  /** Atomic, so two concurrent callers cannot both try to create the same name. */
  ensureArtifact(kind: ArtifactKind, name: string): Promise<ArtifactRow> {
    return this.atomically(async (r) => {
      const existing = await r.getArtifactByName(name);
      if (existing) {
        if (existing.kind !== kind) {
          throw new ToolsmithError(
            `"${name}" already exists as a ${existing.kind} artifact`,
            'validation',
          );
        }
        return existing;
      }
      const now = nowIso();
      const id = randomUUID();
      await r.db.run(
        'INSERT INTO artifacts (id, kind, name, published_version, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
        [id, kind, name, now, now],
      );
      return (await r.getArtifact(id))!;
    });
  }

  async getArtifact(id: string): Promise<ArtifactRow | undefined> {
    const r = await this.db.get('SELECT * FROM artifacts WHERE id = ?', [id]);
    return r ? toArtifact(r) : undefined;
  }

  async getArtifactByName(name: string): Promise<ArtifactRow | undefined> {
    const r = await this.db.get('SELECT * FROM artifacts WHERE name = ?', [name]);
    return r ? toArtifact(r) : undefined;
  }

  /** Resolve "name", "name@3", or an artifact id. */
  async resolve(ref: string): Promise<{ artifact: ArtifactRow; version?: number }> {
    const [name, v] = ref.split('@');
    const artifact = (await this.getArtifactByName(name!)) ?? (await this.getArtifact(name!));
    if (!artifact) {
      throw new ToolsmithError(
        `No integration or tool named "${name}"`,
        'not_found',
        'Run `toolsmith-mcp list` to see what exists.',
      );
    }
    return { artifact, version: v ? Number(v) : undefined };
  }

  async listArtifacts(kind?: ArtifactKind): Promise<ArtifactRow[]> {
    const rows = kind
      ? await this.db.all('SELECT * FROM artifacts WHERE kind = ? ORDER BY name', [kind])
      : await this.db.all('SELECT * FROM artifacts ORDER BY kind, name');
    return rows.map(toArtifact);
  }

  /**
   * Add a version. If the definition is byte-identical to the latest version,
   * that version is returned instead of creating a duplicate.
   */
  addVersion(
    artifactId: string,
    definition: JsonValue,
    origin: string,
    status: Status = 'proposed',
    actor = 'system',
  ): Promise<{ version: VersionRow; created: boolean }> {
    const hash = contentHash(definition);
    return this.atomically(async (r) => {
      const latest = await r.latestVersion(artifactId);
      if (
        latest &&
        latest.contentHash === hash &&
        latest.status !== 'rejected' &&
        latest.status !== 'failed'
      ) {
        return { version: latest, created: false };
      }
      const version = (latest?.version ?? 0) + 1;
      const now = nowIso();
      await r.db.run(
        'INSERT INTO artifact_versions (artifact_id, version, status, definition, content_hash, permissions, evaluation, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        [
          artifactId,
          version,
          status,
          JSON.stringify(definition),
          hash,
          JSON.stringify({ allowWrite: false, allowDestructive: false }),
          origin,
          now,
        ],
      );
      await r.recordEvent(artifactId, version, null, status, actor, `created (${origin})`);
      await r.touch(artifactId);
      return { version: (await r.getVersion(artifactId, version))!, created: true };
    });
  }

  async getVersion(artifactId: string, version: number): Promise<VersionRow | undefined> {
    const r = await this.db.get(
      'SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?',
      [artifactId, version],
    );
    return r ? toVersion(r) : undefined;
  }

  async latestVersion(artifactId: string): Promise<VersionRow | undefined> {
    const r = await this.db.get(
      'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1',
      [artifactId],
    );
    return r ? toVersion(r) : undefined;
  }

  async listVersions(artifactId: string): Promise<VersionRow[]> {
    return (
      await this.db.all(
        'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC',
        [artifactId],
      )
    ).map(toVersion);
  }

  /** All versions in a given status across artifacts (e.g. the approval queue). */
  async versionsByStatus(
    status: Status,
  ): Promise<Array<VersionRow & { name: string; kind: ArtifactKind }>> {
    return (
      await this.db.all(
        'SELECT v.*, a.name AS name, a.kind AS kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.status = ? ORDER BY v.created_at',
        [status],
      )
    ).map((r) => ({ ...toVersion(r), name: String(r.name), kind: r.kind as ArtifactKind }));
  }

  /**
   * One statement, so the artifact and version rows are a consistent
   * snapshot even while another caller publishes or disables.
   */
  async publishedVersions(): Promise<Array<{ artifact: ArtifactRow; version: VersionRow }>> {
    return (
      await this.db.all(
        "SELECT v.*, a.id AS a_id, a.kind AS a_kind, a.name AS a_name, a.published_version AS a_published_version, a.created_at AS a_created_at, a.updated_at AS a_updated_at FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.published_version WHERE v.status = 'published'",
      )
    ).map((r) => ({
      artifact: toArtifact({
        id: r.a_id,
        kind: r.a_kind,
        name: r.a_name,
        published_version: r.a_published_version,
        created_at: r.a_created_at,
        updated_at: r.a_updated_at,
      }),
      version: toVersion(r),
    }));
  }

  transition(
    artifactId: string,
    version: number,
    to: Status,
    actor: string,
    reason?: string,
  ): Promise<VersionRow> {
    return this.atomically((r) => r.transitionInTx(artifactId, version, to, actor, reason));
  }

  /** Call only on a registry from `atomically`. */
  private async transitionInTx(
    artifactId: string,
    version: number,
    to: Status,
    actor: string,
    reason?: string,
  ): Promise<VersionRow> {
    const v = await this.getVersion(artifactId, version);
    if (!v) throw new ToolsmithError(`Version ${version} does not exist`, 'not_found');
    if (!TRANSITIONS[v.status].includes(to)) {
      throw new ToolsmithError(
        `Cannot move version ${version} from "${v.status}" to "${to}"`,
        'policy',
        nextStepHint(v.status),
      );
    }
    if (HUMAN_ONLY.includes(to) && !isHumanActor(actor)) {
      throw new ToolsmithError(`Only a human can move a version to "${to}"`, 'policy');
    }
    await this.db.run(
      'UPDATE artifact_versions SET status = ? WHERE artifact_id = ? AND version = ?',
      [to, artifactId, version],
    );
    await this.recordEvent(artifactId, version, v.status, to, actor, reason ?? null);
    await this.touch(artifactId);
    return (await this.getVersion(artifactId, version))!;
  }

  async setEvaluation(artifactId: string, version: number, evaluation: Evaluation): Promise<void> {
    await this.db.run(
      'UPDATE artifact_versions SET evaluation = ? WHERE artifact_id = ? AND version = ?',
      [JSON.stringify(evaluation), artifactId, version],
    );
  }

  /** Human approval. Write/destructive access must be granted explicitly. */
  async approve(
    artifactId: string,
    version: number,
    permissions: Permissions,
    actor: string,
    reason?: string,
  ): Promise<VersionRow> {
    if (!isHumanActor(actor)) throw new ToolsmithError('Approval must come from a human', 'policy');
    return this.atomically(async (r) => {
      const v = await r.getVersion(artifactId, version);
      if (!v) throw new ToolsmithError(`Version ${version} does not exist`, 'not_found');
      if (v.evaluation && !v.evaluation.passed) {
        throw new ToolsmithError(
          'This version failed evaluation and cannot be approved',
          'policy',
          'Inspect the failing checks with `toolsmith-mcp show <name>`, fix the cause, and re-run `toolsmith-mcp evaluate <name>`.',
        );
      }
      await r.db.run(
        'UPDATE artifact_versions SET permissions = ? WHERE artifact_id = ? AND version = ?',
        [JSON.stringify(permissions), artifactId, version],
      );
      const grant =
        [permissions.allowWrite && 'write', permissions.allowDestructive && 'destructive']
          .filter(Boolean)
          .join('+') || 'read-only';
      return r.transitionInTx(
        artifactId,
        version,
        'approved',
        actor,
        reason ?? `approved (${grant})`,
      );
    });
  }

  async publish(artifactId: string, version: number, actor: string): Promise<VersionRow> {
    const out = await this.atomically(async (r) => {
      const artifact = (await r.getArtifact(artifactId))!;
      if (artifact.publishedVersion && artifact.publishedVersion !== version) {
        const prev = await r.getVersion(artifactId, artifact.publishedVersion);
        if (prev?.status === 'published') {
          await r.transitionInTx(
            artifactId,
            prev.version,
            'approved',
            actor,
            `superseded by v${version}`,
          );
        }
      }
      const v = await r.transitionInTx(artifactId, version, 'published', actor);
      await r.db.run('UPDATE artifacts SET published_version = ? WHERE id = ?', [
        version,
        artifactId,
      ]);
      return v;
    });
    await this.bump();
    return out;
  }

  async disable(artifactId: string, actor: string, reason?: string): Promise<VersionRow> {
    const out = await this.atomically(async (r) => {
      const artifact = (await r.getArtifact(artifactId))!;
      if (!artifact.publishedVersion)
        throw new ToolsmithError(`"${artifact.name}" is not published`, 'validation');
      const v = await r.transitionInTx(
        artifactId,
        artifact.publishedVersion,
        'disabled',
        actor,
        reason,
      );
      await r.db.run('UPDATE artifacts SET published_version = NULL WHERE id = ?', [artifactId]);
      return v;
    });
    await this.bump();
    return out;
  }

  /** Re-enable the most recently disabled version. */
  async enable(artifactId: string, actor: string): Promise<VersionRow> {
    const disabled = (await this.listVersions(artifactId)).find((v) => v.status === 'disabled');
    if (!disabled) throw new ToolsmithError('Nothing to re-enable', 'validation');
    return this.publish(artifactId, disabled.version, actor);
  }

  /**
   * Publish the newest approved version older than the current one. Only
   * versions a human approved before are eligible.
   */
  async rollback(artifactId: string, actor: string, toVersion?: number): Promise<VersionRow> {
    const artifact = (await this.getArtifact(artifactId))!;
    const current = artifact.publishedVersion;
    const candidates = (await this.listVersions(artifactId)).filter(
      (v) =>
        (v.status === 'approved' || v.status === 'disabled') &&
        v.version !== current &&
        (toVersion ? v.version === toVersion : current ? v.version < current : true),
    );
    const target = candidates[0];
    if (!target) {
      throw new ToolsmithError(
        `No earlier approved version of "${artifact.name}" to roll back to`,
        'validation',
        'Only versions that were approved before can be rolled back to.',
      );
    }
    return this.publish(artifactId, target.version, actor);
  }

  async events(artifactId?: string, limit = 200): Promise<LifecycleEvent[]> {
    const rows = artifactId
      ? await this.db.all(
          'SELECT * FROM lifecycle_events WHERE artifact_id = ? ORDER BY id DESC LIMIT ?',
          [artifactId, limit],
        )
      : await this.db.all('SELECT * FROM lifecycle_events ORDER BY id DESC LIMIT ?', [limit]);
    return rows.map((r) => ({
      artifactId: String(r.artifact_id),
      version: Number(r.version),
      fromStatus: (r.from_status as Status) ?? null,
      toStatus: r.to_status as Status,
      actor: String(r.actor),
      reason: (r.reason as string) ?? null,
      at: String(r.at),
    }));
  }

  private async recordEvent(
    artifactId: string,
    version: number,
    from: Status | null,
    to: Status,
    actor: string,
    reason: string | null,
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO lifecycle_events (artifact_id, version, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [artifactId, version, from, to, actor, reason, nowIso()],
    );
  }

  private async touch(artifactId: string): Promise<void> {
    await this.db.run('UPDATE artifacts SET updated_at = ? WHERE id = ?', [nowIso(), artifactId]);
  }
}

function nextStepHint(status: Status): string {
  switch (status) {
    case 'awaiting_approval':
      return 'Approve it with `toolsmith-mcp approve <name>` or reject it with `toolsmith-mcp reject <name>`.';
    case 'approved':
      return 'Publish it with `toolsmith-mcp publish <name>`.';
    case 'proposed':
    case 'failed':
      return 'Run `toolsmith-mcp evaluate <name>` to test it.';
    default:
      return `Current status is "${status}".`;
  }
}

export function contentHash(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function toArtifact(r: Record<string, unknown>): ArtifactRow {
  return {
    id: String(r.id),
    kind: r.kind as ArtifactKind,
    name: String(r.name),
    publishedVersion: r.published_version === null ? null : Number(r.published_version),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toVersion(r: Record<string, unknown>): VersionRow {
  return {
    artifactId: String(r.artifact_id),
    version: Number(r.version),
    status: r.status as Status,
    definition: JSON.parse(String(r.definition)) as JsonValue,
    contentHash: String(r.content_hash),
    permissions: JSON.parse(String(r.permissions)) as Permissions,
    evaluation: r.evaluation ? (JSON.parse(String(r.evaluation)) as Evaluation) : null,
    origin: String(r.origin),
    createdAt: String(r.created_at),
  };
}
