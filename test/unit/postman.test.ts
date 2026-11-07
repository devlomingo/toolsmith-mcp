import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importOpenApi } from '../../src/openapi/import.js';
import { isPostmanCollection, postmanToOpenApi } from '../../src/openapi/postman.js';

const collection = JSON.parse(readFileSync('test/fixtures/shop.postman_collection.json', 'utf8'));

describe('Postman collection import', () => {
  it('detects collections and converts folders, variables and :params', () => {
    expect(isPostmanCollection(collection)).toBe(true);
    expect(isPostmanCollection({ openapi: '3.0.0' })).toBe(false);
    const doc = postmanToOpenApi(collection) as {
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.servers[0]!.url).toBe('https://api.shop.example.com');
    expect(Object.keys(doc.paths).sort()).toEqual(['/products', '/products/{id}']);
  });

  it('becomes typed tools with access levels and inferred schemas', async () => {
    const def = await importOpenApi(collection, { name: 'pm' });
    const by = Object.fromEntries(def.operations.map((o) => [o.name, o]));
    expect(Object.keys(by).sort()).toEqual([
      'createProduct',
      'deleteProduct',
      'getProduct',
      'listProducts',
    ]);
    expect(by.getProduct!.inputSchema).toMatchObject({ required: ['id'] });
    expect(by.listProducts!.outputSchema).toMatchObject({
      properties: {
        result: { type: 'array', items: { properties: { price: { type: 'number' } } } },
      },
    });
    expect(by.createProduct!.inputSchema).toMatchObject({
      properties: {
        body: { properties: { name: { type: 'string' }, price: { type: 'integer' } } },
      },
    });
    expect(by.deleteProduct!.access).toBe('destructive');
    expect(def.findings.some((f) => f.code === 'from_postman')).toBe(true);
  });

  it('asks for a base URL when the collection only has an unresolved variable', async () => {
    const c = structuredClone(collection);
    c.variable = [];
    await expect(importOpenApi(c, { name: 'pm' })).rejects.toThrow(
      /does not say where the API is hosted/,
    );
    expect((await importOpenApi(c, { name: 'pm', baseUrl: 'https://x.example' })).baseUrl).toBe(
      'https://x.example',
    );
  });
});
