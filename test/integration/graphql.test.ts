import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Toolsmith } from '../../src/app.js';
import { parseConfig } from '../../src/config/config.js';

const T = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType });
const NN = (t: unknown) => T('NON_NULL', null, t);
const L = (t: unknown) => T('LIST', null, t);
const schema = {
  __schema: {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      {
        kind: 'OBJECT',
        name: 'Query',
        fields: [
          {
            name: 'products',
            description: 'List products',
            args: [{ name: 'category', type: T('ENUM', 'Category') }],
            type: NN(L(NN(T('OBJECT', 'Product')))),
          },
          {
            name: 'product',
            description: 'One product',
            args: [{ name: 'id', type: NN(T('SCALAR', 'ID')) }],
            type: T('OBJECT', 'Product'),
          },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'Mutation',
        fields: [
          {
            name: 'createProduct',
            args: [{ name: 'input', type: NN(T('INPUT_OBJECT', 'ProductInput')) }],
            type: T('OBJECT', 'Product'),
          },
          {
            name: 'deleteProduct',
            args: [{ name: 'id', type: NN(T('SCALAR', 'ID')) }],
            type: T('SCALAR', 'Boolean'),
          },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'Product',
        fields: [
          { name: 'id', args: [], type: NN(T('SCALAR', 'ID')) },
          { name: 'name', args: [], type: T('SCALAR', 'String') },
          { name: 'price', args: [], type: T('SCALAR', 'Float') },
          { name: 'category', args: [], type: T('ENUM', 'Category') },
          { name: 'supplier', args: [], type: T('OBJECT', 'Supplier') },
        ],
      },
      {
        kind: 'OBJECT',
        name: 'Supplier',
        fields: [{ name: 'name', args: [], type: T('SCALAR', 'String') }],
      },
      { kind: 'ENUM', name: 'Category', enumValues: [{ name: 'BOOKS' }, { name: 'GAMES' }] },
      {
        kind: 'INPUT_OBJECT',
        name: 'ProductInput',
        inputFields: [
          { name: 'name', type: NN(T('SCALAR', 'String')) },
          { name: 'price', type: T('SCALAR', 'Float') },
        ],
      },
      { kind: 'SCALAR', name: 'ID' },
      { kind: 'SCALAR', name: 'String' },
      { kind: 'SCALAR', name: 'Float' },
      { kind: 'SCALAR', name: 'Boolean' },
    ],
  },
};
const products = [
  { id: '1', name: 'Book', price: 9.5, category: 'BOOKS', supplier: { name: 'Acme' } },
  { id: '2', name: 'Game', price: 30, category: 'GAMES', supplier: { name: 'Fun' } },
];

let stop: (() => void) | undefined;
let app: Toolsmith | undefined;
afterEach(async () => {
  await app?.close();
  stop?.();
});

async function gqlServer() {
  const seen: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.headers.authorization !== 'Bearer gql-token-123456')
        return res.end(JSON.stringify({ errors: [{ message: 'unauthorized' }] }));
      const { query, variables } = JSON.parse(body);
      seen.push({ query, variables });
      if (query.includes('__schema')) return res.end(JSON.stringify({ data: schema }));
      const field = query.match(/\{\s*(\w+)/)![1];
      if (field === 'products')
        return res.end(
          JSON.stringify({
            data: {
              products: products.filter(
                (p) => !variables.category || p.category === variables.category,
              ),
            },
          }),
        );
      if (field === 'product') {
        const p = products.find((x) => x.id === variables.id);
        return res.end(
          JSON.stringify(
            p
              ? { data: { product: p } }
              : { data: { product: null }, errors: [{ message: `no product ${variables.id}` }] },
          ),
        );
      }
      res.end(JSON.stringify({ data: { [field]: true } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  stop = () => srv.close();
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/graphql`, seen };
}

describe('GraphQL source', () => {
  it('introspects, generates typed tools, and runs queries with variables', async () => {
    const gql = await gqlServer();
    process.env.GQL_TOKEN = 'gql-token-123456';
    app = await Toolsmith.open(
      parseConfig(
        {
          integrations: [
            {
              name: 'gql',
              type: 'graphql',
              spec: gql.url,
              auth: { type: 'bearer', token: '${env:GQL_TOKEN}' },
              allowPrivateNetwork: true,
            },
          ],
        },
        process.cwd(),
      ),
      { dbPath: ':memory:' },
    );
    const v = await app.importIntegration('gql', 'human:test');
    expect(v.status).toBe('awaiting_approval');
    expect(v.evaluation!.metrics!.verifiedOperations).toBe(1); // products: the read without required args
    const ops = Object.fromEntries(
      (
        v.definition as unknown as {
          operations: Array<{
            name: string;
            access: string;
            inputSchema: unknown;
            graphql: { document: string };
          }>;
        }
      ).operations.map((o) => [o.name, o]),
    );
    expect(ops.products!.access).toBe('read');
    expect(ops.createProduct!.access).toBe('write');
    expect(ops.deleteProduct!.access).toBe('destructive');
    expect(ops.products!.inputSchema).toMatchObject({
      properties: { category: { type: 'string', enum: ['BOOKS', 'GAMES'] } },
    });
    expect(ops.createProduct!.inputSchema).toMatchObject({
      required: ['input'],
      properties: { input: { type: 'object', required: ['name'] } },
    });
    expect(ops.products!.graphql.document).toMatch(
      /products\(category: \$category\) \{ id name price category supplier \{ name \} \}/,
    );

    await app.approve('gql', { allowWrite: false, allowDestructive: false }, 'human:test');
    expect(app.catalog.has('gql__createProduct')).toBe(false);
    const r = await app.call('gql__products', { category: 'GAMES' }, { sessionId: 's' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([products[1]]);
    expect(gql.seen.at(-1)!.variables).toEqual({ category: 'GAMES' }); // passed as variables, not spliced
    const missing = await app.call('gql__product', { id: '999' }, { sessionId: 's' });
    expect(missing).toMatchObject({ ok: false, errorCode: 'upstream' });
    expect(missing.error).toMatch(/GraphQL error: no product 999/);
    expect(
      (await app.call('gql__products', { category: 'NOPE' }, { sessionId: 's' })).errorCode,
    ).toBe('validation');
  });
});
