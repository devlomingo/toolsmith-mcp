import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Server } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import type { Toolsmith } from '../app.js';
import { createServerFactory } from './mcp.js';

/**
 * Serve MCP over stdio. One process serves one client, so the whole
 * connection is one trace session. stdout carries protocol traffic only;
 * all diagnostics go to stderr.
 */
export function startStdio(app: Toolsmith): { close: () => Promise<void> } {
  const servers = new Set<Server>();
  const sessionId = `stdio:${randomUUID().slice(0, 8)}`;
  const handle = serveStdio(
    createServerFactory(app, { sessionId, onServer: (s) => servers.add(s) }),
    { onerror: (e) => process.stderr.write(`[toolsmith] stdio: ${e.message}\n`) },
  );
  const unsubscribe = app.onToolsChanged(() => {
    for (const s of servers) {
      // Not every connection has asked for list_changed; ignore the ones that cannot take it.
      void Promise.resolve()
        .then(() => s.sendToolListChanged())
        .catch(() => undefined);
    }
  });
  return {
    close: async () => {
      unsubscribe();
      await handle.close();
    },
  };
}
