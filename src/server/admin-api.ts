import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Toolsmith } from '../app.js';
import { ToolsmithError } from '../core/errors.js';
import type { JsonObject } from '../core/types.js';
import { json } from './http.js';

const ACTOR = 'human:dashboard';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new ToolsmithError('Request body too large', 'validation');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ToolsmithError('Body must be JSON', 'validation');
  }
}

/** Admin REST API backing the dashboard. Every mutating call is audited. */
export async function handleAdminApi(
  app: Toolsmith,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const q = url.searchParams;
  try {
    if (method === 'GET' && parts[0] === 'overview') {
      const artifacts = app.registry.listArtifacts();
      const statuses: Record<string, number> = {};
      for (const a of artifacts) {
        const v = app.registry.latestVersion(a.id);
        if (v) statuses[v.status] = (statuses[v.status] ?? 0) + 1;
      }
      const since = Date.now() - 86_400_000;
      const stats = app.traces.stats(since);
      return json(res, 200, {
        version: (await import('../app.js')).VERSION,
        tools: app.catalog.list().length,
        artifacts: artifacts.length,
        statuses,
        awaitingApproval: app.registry.versionsByStatus('awaiting_approval').length,
        pendingCallApprovals: app.approvals.list('pending').length,
        upstreams: app.upstreams.status(),
        problems: app.catalog.problems,
        traces: app.traces.count(),
        last24h: {
          calls: stats.reduce((s, x) => s + x.calls, 0),
          errors: stats.reduce((s, x) => s + x.errors, 0),
          upstreamRequests: stats.reduce((s, x) => s + x.upstreamRequests, 0),
        },
      });
    }
    if (method === 'GET' && parts[0] === 'tools') return json(res, 200, app.catalog.list());
    if (parts[0] === 'artifacts') {
      if (method === 'GET' && parts.length === 1) {
        return json(
          res,
          200,
          app.registry.listArtifacts().map((a) => {
            const latest = app.registry.latestVersion(a.id);
            return {
              ...a,
              latestVersion: latest?.version,
              latestStatus: latest?.status,
              origin: latest?.origin,
              evaluationPassed: latest?.evaluation?.passed ?? null,
            };
          }),
        );
      }
      const name = decodeURIComponent(parts[1] ?? '');
      if (method === 'GET' && parts.length === 2) {
        const { artifact } = app.registry.resolve(name);
        return json(res, 200, {
          artifact,
          versions: app.registry.listVersions(artifact.id),
          events: app.registry.events(artifact.id),
        });
      }
      if (method === 'POST' && parts.length === 3) {
        const b = await body(req);
        const ref = b.version ? `${name}@${Number(b.version)}` : name;
        switch (parts[2]) {
          case 'approve':
            return json(
              res,
              200,
              app.approve(
                ref,
                {
                  allowWrite: b.allowWrite === true,
                  allowDestructive: b.allowDestructive === true,
                  ...(typeof b.description === 'string' && b.description.trim()
                    ? { description: b.description.trim().slice(0, 2000) }
                    : {}),
                },
                ACTOR,
                b.publish !== false,
              ),
            );
          case 'reject':
            return json(
              res,
              200,
              app.reject(ref, ACTOR, typeof b.reason === 'string' ? b.reason : undefined),
            );
          case 'publish':
            return json(res, 200, app.publish(ref, ACTOR));
          case 'disable':
            return json(
              res,
              200,
              app.disable(name, ACTOR, typeof b.reason === 'string' ? b.reason : undefined),
            );
          case 'enable':
            return json(res, 200, app.enable(name, ACTOR));
          case 'rollback':
            return json(res, 200, app.rollback(ref, ACTOR));
          case 'evaluate': {
            const inputs = Array.isArray(b.inputs)
              ? (b.inputs as JsonObject[])
              : b.input && typeof b.input === 'object'
                ? [b.input as JsonObject]
                : [];
            return json(res, 200, await app.evaluateLatest(name, inputs, ACTOR, b.live !== false));
          }
        }
      }
    }
    if (method === 'POST' && parts[0] === 'integrations' && parts[2] === 'import') {
      return json(res, 200, await app.importIntegration(decodeURIComponent(parts[1]!), ACTOR));
    }
    if (method === 'GET' && parts[0] === 'traces') {
      if (parts[1] === 'stats')
        return json(
          res,
          200,
          app.traces.stats(q.get('since') ? Number(q.get('since')) : undefined),
        );
      if (parts[1]) return json(res, 200, { children: app.traces.children(parts[1]) });
      return json(
        res,
        200,
        app.traces.query({
          tool: q.get('tool') ?? undefined,
          sessionId: q.get('session') ?? undefined,
          ok: q.get('ok') === null ? undefined : q.get('ok') === 'true',
          topLevelOnly: q.get('all') !== 'true',
          limit: Math.min(Number(q.get('limit') ?? 100), 500),
          offset: Number(q.get('offset') ?? 0),
        }),
      );
    }
    if (method === 'GET' && parts[0] === 'composites' && parts[1] === 'usage')
      return json(res, 200, app.compositeUsage());
    if (parts[0] === 'patterns') {
      if (method === 'GET') return json(res, 200, app.mine());
      if (method === 'POST' && parts[1] === 'propose') {
        const out = await app.proposeComposites(ACTOR);
        return json(
          res,
          200,
          out.map((o) => ({
            pattern: o.pattern.signature,
            composite: o.def?.name,
            status: o.version?.status,
            error: o.error,
          })),
        );
      }
    }
    if (parts[0] === 'capabilities') {
      if (method === 'GET') return json(res, 200, app.discovery.list());
      if (method === 'POST') {
        const b = await body(req);
        if (typeof b.request !== 'string' || b.request.length < 3)
          throw new ToolsmithError('"request" is required', 'validation');
        return json(res, 200, await app.analyzeCapability(b.request, 'dashboard'));
      }
    }
    if (parts[0] === 'call-approvals') {
      if (method === 'GET')
        return json(res, 200, app.approvals.list((q.get('status') as never) ?? undefined));
      if (method === 'POST' && parts[1]) {
        const b = await body(req);
        app.audit.write(ACTOR, b.approve === true ? 'approve-call' : 'reject-call', parts[1]);
        return json(res, 200, app.approvals.decide(parts[1], b.approve === true, ACTOR));
      }
    }
    if (method === 'GET' && parts[0] === 'audit') return json(res, 200, app.audit.list());
    if (method === 'GET' && parts[0] === 'events')
      return json(res, 200, app.registry.events(undefined, 200));
    if (method === 'GET' && parts[0] === 'benchmarks') {
      // Results next to the config (a checkout that ran `npm run benchmark`),
      // else the results shipped with the package.
      const local = resolve(app.loaded.baseDir, 'benchmarks/results/latest.json');
      const shipped = fileURLToPath(
        new URL('../../benchmarks/results/latest.json', import.meta.url),
      );
      const file = existsSync(local) ? local : shipped;
      return json(res, 200, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
    }
    json(res, 404, { error: `No admin endpoint ${method} ${url.pathname}` });
  } catch (err) {
    if (err instanceof ToolsmithError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'policy' ? 409 : 400;
      return json(res, status, { error: err.message, hint: err.hint });
    }
    throw err;
  }
}
