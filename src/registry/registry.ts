import { createHash, randomUUID } from 'node:crypto';
import { ToolsmithError } from '../core/errors.js';
import type { JsonValue } from '../core/types.js';
import { nowIso, transaction, type Db } from '../store/db.js';

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
  private listeners = new Set<() => void>();

  constructor(private readonly db: Db) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Monotonic counter other processes poll to notice catalog changes. */
  revision(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'catalog_rev'").get() as
      { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private bump(): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('catalog_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
      )
      .run();
    for (const fn of this.listeners) fn();
  }

  ensureArtifact(kind: ArtifactKind, name: string): ArtifactRow {
    const existing = this.getArtifactByName(name);
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
    this.db
      .prepare(
        'INSERT INTO artifacts (id, kind, name, published_version, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
      )
      .run(id, kind, name, now, now);
    return this.getArtifact(id)!;
  }

  getArtifact(id: string): ArtifactRow | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? toArtifact(r) : undefined;
  }

  getArtifactByName(name: string): ArtifactRow | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE name = ?').get(name) as
      Record<string, unknown> | undefined;
    return r ? toArtifact(r) : undefined;
  }

  /** Resolve "name", "name@3", or an artifact id. */
  resolve(ref: string): { artifact: ArtifactRow; version?: number } {
    const [name, v] = ref.split('@');
    const artifact = this.getArtifactByName(name!) ?? this.getArtifact(name!);
    if (!artifact) {
      throw new ToolsmithError(
        `No integration or tool named "${name}"`,
        'not_found',
        'Run `toolsmith-mcp list` to see what exists.',
      );
    }
    return { artifact, version: v ? Number(v) : undefined };
  }

  listArtifacts(kind?: ArtifactKind): ArtifactRow[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT * FROM artifacts WHERE kind = ? ORDER BY name').all(kind)
        : this.db.prepare('SELECT * FROM artifacts ORDER BY kind, name').all()
    ) as Record<string, unknown>[];
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
  ): { version: VersionRow; created: boolean } {
    const hash = contentHash(definition);
    return transaction(this.db, () => {
      const latest = this.latestVersion(artifactId);
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
      this.db
        .prepare(
          'INSERT INTO artifact_versions (artifact_id, version, status, definition, content_hash, permissions, evaluation, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        )
        .run(
          artifactId,
          version,
          status,
          JSON.stringify(definition),
          hash,
          JSON.stringify({ allowWrite: false, allowDestructive: false }),
          origin,
          now,
        );
      this.recordEvent(artifactId, version, null, status, actor, `created (${origin})`);
      this.touch(artifactId);
      return { version: this.getVersion(artifactId, version)!, created: true };
    });
  }

  getVersion(artifactId: string, version: number): VersionRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(artifactId, version) as Record<string, unknown> | undefined;
    return r ? toVersion(r) : undefined;
  }

  latestVersion(artifactId: string): VersionRow | undefined {
    const r = this.db
      .prepare(
        'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(artifactId) as Record<string, unknown> | undefined;
    return r ? toVersion(r) : undefined;
  }

  listVersions(artifactId: string): VersionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC')
        .all(artifactId) as Record<string, unknown>[]
    ).map(toVersion);
  }

  /** All versions in a given status across artifacts (e.g. the approval queue). */
  versionsByStatus(status: Status): Array<VersionRow & { name: string; kind: ArtifactKind }> {
    return (
      this.db
        .prepare(
          'SELECT v.*, a.name AS name, a.kind AS kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.status = ? ORDER BY v.created_at',
        )
        .all(status) as Record<string, unknown>[]
    ).map((r) => ({ ...toVersion(r), name: String(r.name), kind: r.kind as ArtifactKind }));
  }

  publishedVersions(): Array<{ artifact: ArtifactRow; version: VersionRow }> {
    return (
      this.db
        .prepare(
          "SELECT a.id AS a_id FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.published_version WHERE v.status = 'published'",
        )
        .all() as Array<{ a_id: string }>
    ).map(({ a_id }) => {
      const artifact = this.getArtifact(a_id)!;
      return { artifact, version: this.getVersion(a_id, artifact.publishedVersion!)! };
    });
  }

  transition(
    artifactId: string,
    version: number,
    to: Status,
    actor: string,
    reason?: string,
  ): VersionRow {
    return transaction(this.db, () => this.transitionInTx(artifactId, version, to, actor, reason));
  }

  private transitionInTx(
    artifactId: string,
    version: number,
    to: Status,
    actor: string,
    reason?: string,
  ): VersionRow {
    const v = this.getVersion(artifactId, version);
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
    this.db
      .prepare('UPDATE artifact_versions SET status = ? WHERE artifact_id = ? AND version = ?')
      .run(to, artifactId, version);
    this.recordEvent(artifactId, version, v.status, to, actor, reason ?? null);
    this.touch(artifactId);
    return this.getVersion(artifactId, version)!;
  }

  setEvaluation(artifactId: string, version: number, evaluation: Evaluation): void {
    this.db
      .prepare('UPDATE artifact_versions SET evaluation = ? WHERE artifact_id = ? AND version = ?')
      .run(JSON.stringify(evaluation), artifactId, version);
  }

  /** Human approval. Write/destructive access must be granted explicitly. */
  approve(
    artifactId: string,
    version: number,
    permissions: Permissions,
    actor: string,
    reason?: string,
  ): VersionRow {
    if (!isHumanActor(actor)) throw new ToolsmithError('Approval must come from a human', 'policy');
    return transaction(this.db, () => {
      const v = this.getVersion(artifactId, version);
      if (!v) throw new ToolsmithError(`Version ${version} does not exist`, 'not_found');
      if (v.evaluation && !v.evaluation.passed) {
        throw new ToolsmithError(
          'This version failed evaluation and cannot be approved',
          'policy',
          'Inspect the failing checks with `toolsmith-mcp show <name>`, fix the cause, and re-run `toolsmith-mcp evaluate <name>`.',
        );
      }
      this.db
        .prepare(
          'UPDATE artifact_versions SET permissions = ? WHERE artifact_id = ? AND version = ?',
        )
        .run(JSON.stringify(permissions), artifactId, version);
      const grant =
        [permissions.allowWrite && 'write', permissions.allowDestructive && 'destructive']
          .filter(Boolean)
          .join('+') || 'read-only';
      return this.transitionInTx(
        artifactId,
        version,
        'approved',
        actor,
        reason ?? `approved (${grant})`,
      );
    });
  }

  publish(artifactId: string, version: number, actor: string): VersionRow {
    const out = transaction(this.db, () => {
      const artifact = this.getArtifact(artifactId)!;
      if (artifact.publishedVersion && artifact.publishedVersion !== version) {
        const prev = this.getVersion(artifactId, artifact.publishedVersion);
        if (prev?.status === 'published') {
          this.transitionInTx(
            artifactId,
            prev.version,
            'approved',
            actor,
            `superseded by v${version}`,
          );
        }
      }
      const v = this.transitionInTx(artifactId, version, 'published', actor);
      this.db
        .prepare('UPDATE artifacts SET published_version = ? WHERE id = ?')
        .run(version, artifactId);
      return v;
    });
    this.bump();
    return out;
  }

  disable(artifactId: string, actor: string, reason?: string): VersionRow {
    const out = transaction(this.db, () => {
      const artifact = this.getArtifact(artifactId)!;
      if (!artifact.publishedVersion)
        throw new ToolsmithError(`"${artifact.name}" is not published`, 'validation');
      const v = this.transitionInTx(
        artifactId,
        artifact.publishedVersion,
        'disabled',
        actor,
        reason,
      );
      this.db.prepare('UPDATE artifacts SET published_version = NULL WHERE id = ?').run(artifactId);
      return v;
    });
    this.bump();
    return out;
  }

  /** Re-enable the most recently disabled version. */
  enable(artifactId: string, actor: string): VersionRow {
    const disabled = this.listVersions(artifactId).find((v) => v.status === 'disabled');
    if (!disabled) throw new ToolsmithError('Nothing to re-enable', 'validation');
    return this.publish(artifactId, disabled.version, actor);
  }

  /**
   * Publish the newest approved version older than the current one. Only
   * versions a human approved before are eligible.
   */
  rollback(artifactId: string, actor: string, toVersion?: number): VersionRow {
    const artifact = this.getArtifact(artifactId)!;
    const current = artifact.publishedVersion;
    const candidates = this.listVersions(artifactId).filter(
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

  events(artifactId?: string, limit = 200): LifecycleEvent[] {
    const rows = (
      artifactId
        ? this.db
            .prepare(
              'SELECT * FROM lifecycle_events WHERE artifact_id = ? ORDER BY id DESC LIMIT ?',
            )
            .all(artifactId, limit)
        : this.db.prepare('SELECT * FROM lifecycle_events ORDER BY id DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];
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

  private recordEvent(
    artifactId: string,
    version: number,
    from: Status | null,
    to: Status,
    actor: string,
    reason: string | null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO lifecycle_events (artifact_id, version, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(artifactId, version, from, to, actor, reason, nowIso());
  }

  private touch(artifactId: string): void {
    this.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(nowIso(), artifactId);
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
