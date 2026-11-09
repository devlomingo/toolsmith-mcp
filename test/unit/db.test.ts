import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';

const audit = (actor: string): [string, unknown[]] => [
  'INSERT INTO audit_log (at, actor, action) VALUES (?, ?, ?)',
  ['2026-01-01T00:00:00.000Z', actor, 'test'],
];

async function actors(db: ReturnType<typeof openDb>): Promise<string[]> {
  return (await db.all<{ actor: string }>('SELECT actor FROM audit_log ORDER BY id')).map(
    (r) => r.actor,
  );
}

/** Resolves on the next macrotask, after every pending microtask has run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('SqliteDb', () => {
  it('holds other callers back while a transaction is open', async () => {
    const db = openDb(':memory:');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.transaction(async (t) => {
      await t.run(...audit('tx'));
      await gate;
      return t.run(...audit('tx-end'));
    });
    await tick(); // the transaction has begun and is waiting on the gate
    let outsideDone = false;
    const outside = db.run(...audit('outside')).then(() => (outsideDone = true));
    await tick();
    expect(outsideDone).toBe(false);
    release();
    await Promise.all([tx, outside]);
    expect(await actors(db)).toEqual(['tx', 'tx-end', 'outside']);
    await db.close();
  });

  it('a rollback does not drop a write another caller made meanwhile', async () => {
    const db = openDb(':memory:');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.transaction(async (t) => {
      await t.run(...audit('rolled-back'));
      await gate;
      throw new Error('boom');
    });
    await tick(); // the transaction has begun and is waiting on the gate
    const outside = db.run(...audit('kept'));
    await tick();
    release();
    await expect(tx).rejects.toThrow('boom');
    await outside;
    expect(await actors(db)).toEqual(['kept']);
    await db.close();
  });

  it('runs a nested transaction inside the outer one', async () => {
    const db = openDb(':memory:');
    await expect(
      db.transaction(async (t) => {
        await t.transaction((inner) => inner.run(...audit('inner')));
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await actors(db)).toEqual([]);
    await db.close();
  });

  it('refuses a transaction handle used after its transaction ended', async () => {
    const db = openDb(':memory:');
    const leaked = await db.transaction(async (t) => t);
    await expect(leaked.run(...audit('late'))).rejects.toThrow(/after the transaction ended/);
    await db.close();
  });
});
