import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small e-commerce API used by the demo, the test suite and the benchmarks.
 * Deterministic seed data, configurable latency, auth, rate limiting and
 * fault injection, and a request counter so benchmarks can measure real
 * upstream request counts.
 */

export interface ShopOptions {
  port?: number;
  /** Fixed latency added to every request (ms). */
  latencyMs?: number;
  /** Random extra latency up to this many ms (seeded, reproducible). */
  jitterMs?: number;
  /** Require `Authorization: Bearer <token>`. */
  token?: string;
  /** Tokens that are recognised but expired (answer 401 with a distinct body). */
  expiredTokens?: string[];
  /** Max requests per second before answering 429. 0 = unlimited. */
  rateLimitPerSec?: number;
  /** Paths (regex) that always fail with 500. */
  failPaths?: string[];
  /** Paths (regex) that never answer (to test timeouts). */
  hangPaths?: string[];
  users?: number;
  ordersPerUser?: number;
  seed?: number;
}

interface Product { id: number; name: string; price: number; stock: number; category: string }
interface User { id: number; name: string; email: string; tier: string }
interface Order { id: number; userId: number; status: string; total: number; createdAt: string }
interface OrderItem { id: number; orderId: number; productId: number; quantity: number; unitPrice: number }
interface Payment { id: number; orderId: number; status: string; amount: number; method: string }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export class ShopApi {
  products: Product[] = [];
  users: User[] = [];
  orders: Order[] = [];
  items: OrderItem[] = [];
  payments: Payment[] = [];
  requestCount = 0;
  requestsByRoute: Record<string, number> = {};
  private server?: Server;
  private windowStart = 0;
  private windowCount = 0;
  private jitter: () => number;

  constructor(readonly opts: ShopOptions = {}) {
    const rand = rng(opts.seed ?? 42);
    this.jitter = rng((opts.seed ?? 42) + 1);
    const categories = ['books', 'games', 'garden', 'kitchen'];
    for (let i = 1; i <= 20; i++) {
      this.products.push({ id: i, name: `Product ${i}`, price: Math.round(rand() * 10000) / 100 + 1, stock: Math.floor(rand() * 50), category: categories[i % 4]! });
    }
    let orderId = 1;
    let itemId = 1;
    let paymentId = 1;
    for (let u = 1; u <= (opts.users ?? 25); u++) {
      this.users.push({ id: u, name: `User ${u}`, email: `user${u}@example.test`, tier: u % 5 === 0 ? 'gold' : 'standard' });
      for (let o = 0; o < (opts.ordersPerUser ?? 3); o++) {
        const order: Order = { id: orderId++, userId: u, status: ['placed', 'shipped', 'delivered'][o % 3]!, total: 0, createdAt: new Date(Date.UTC(2026, 0, 1 + o * 7 + u)).toISOString() };
        const n = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < n; k++) {
          const p = this.products[Math.floor(rand() * this.products.length)]!;
          const qty = 1 + Math.floor(rand() * 3);
          this.items.push({ id: itemId++, orderId: order.id, productId: p.id, quantity: qty, unitPrice: p.price });
          order.total = Math.round((order.total + qty * p.price) * 100) / 100;
        }
        this.payments.push({ id: paymentId++, orderId: order.id, status: o % 3 === 0 ? 'pending' : 'captured', amount: order.total, method: u % 2 ? 'card' : 'paypal' });
        this.orders.push(order);
      }
    }
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port ?? 0, '127.0.0.1', resolve));
    return this.baseUrl;
  }

  get baseUrl(): string {
    const addr = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  resetCounters(): void {
    this.requestCount = 0;
    this.requestsByRoute = {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/openapi.json') return send(res, 200, shopOpenApi(this.baseUrl));
    this.requestCount++;
    const delay = (this.opts.latencyMs ?? 0) + Math.floor(this.jitter() * (this.opts.jitterMs ?? 0));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (this.opts.hangPaths?.some((p) => new RegExp(p).test(path))) return; // never answer
    if (this.opts.rateLimitPerSec) {
      const now = Date.now();
      if (now - this.windowStart >= 1000) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      if (++this.windowCount > this.opts.rateLimitPerSec) {
        res.setHeader('retry-after', '1');
        return send(res, 429, { error: 'rate limited' });
      }
    }
    if (this.opts.token) {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (this.opts.expiredTokens?.includes(token)) return send(res, 401, { error: 'token expired' });
      if (token !== this.opts.token) return send(res, 401, { error: 'invalid token' });
    }
    if (this.opts.failPaths?.some((p) => new RegExp(p).test(path))) return send(res, 500, { error: 'injected failure' });

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readJson(req) : undefined;
    const m = (re: RegExp): RegExpMatchArray | null => path.match(re);
    const route = (name: string): void => void (this.requestsByRoute[name] = (this.requestsByRoute[name] ?? 0) + 1);
    let mm: RegExpMatchArray | null;

    if (req.method === 'GET' && path === '/products') {
      route('listProducts');
      const cat = url.searchParams.get('category');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(res, 200, this.products.filter((p) => !cat || p.category === cat).slice(0, limit));
    }
    if ((mm = m(/^\/products\/(\d+)$/))) {
      const p = this.products.find((x) => x.id === Number(mm![1]));
      if (req.method === 'GET') return route('getProduct'), p ? send(res, 200, p) : send(res, 404, { error: 'product not found' });
      if (req.method === 'PUT') {
        route('updateProduct');
        if (!p) return send(res, 404, { error: 'product not found' });
        Object.assign(p, pick(body, ['name', 'price', 'stock', 'category']));
        return send(res, 200, p);
      }
      if (req.method === 'DELETE') {
        route('deleteProduct');
        if (!p) return send(res, 404, { error: 'product not found' });
        this.products = this.products.filter((x) => x !== p);
        return send(res, 200, { deleted: p.id });
      }
    }
    if (req.method === 'POST' && path === '/products') {
      route('createProduct');
      const b = body as Partial<Product> | undefined;
      if (!b?.name || typeof b.price !== 'number') return send(res, 422, { error: 'name and price are required' });
      const p: Product = { id: Math.max(0, ...this.products.map((x) => x.id)) + 1, name: b.name, price: b.price, stock: b.stock ?? 0, category: b.category ?? 'misc' };
      this.products.push(p);
      return send(res, 201, p);
    }
    if (req.method === 'GET' && (mm = m(/^\/users\/(\d+)$/))) {
      route('getUser');
      const u = this.users.find((x) => x.id === Number(mm![1]));
      return u ? send(res, 200, u) : send(res, 404, { error: 'user not found' });
    }
    if (req.method === 'GET' && (mm = m(/^\/users\/(\d+)\/orders$/))) {
      route('getUserOrders');
      return send(res, 200, this.orders.filter((o) => o.userId === Number(mm![1])));
    }
    if (req.method === 'GET' && path === '/orders') {
      route('listOrders');
      const status = url.searchParams.get('status');
      return send(res, 200, this.orders.filter((o) => !status || o.status === status).slice(0, 100));
    }
    if (req.method === 'GET' && (mm = m(/^\/orders\/(\d+)$/))) {
      route('getOrder');
      const o = this.orders.find((x) => x.id === Number(mm![1]));
      return o ? send(res, 200, o) : send(res, 404, { error: 'order not found' });
    }
    if (req.method === 'GET' && (mm = m(/^\/orders\/(\d+)\/items$/))) {
      route('getOrderItems');
      return send(res, 200, this.items.filter((i) => i.orderId === Number(mm![1])));
    }
    if (req.method === 'GET' && (mm = m(/^\/orders\/(\d+)\/payments$/))) {
      route('getOrderPayments');
      return send(res, 200, this.payments.filter((p) => p.orderId === Number(mm![1])));
    }
    return send(res, 404, { error: 'no such endpoint' });
  }
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === 'object') for (const k of keys) if (k in obj) out[k] = (obj as Record<string, unknown>)[k];
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(undefined);
      }
    });
  });
}

const product = {
  type: 'object',
  required: ['id', 'name', 'price'],
  properties: { id: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number' }, stock: { type: 'integer' }, category: { type: 'string' } },
};
const order = {
  type: 'object',
  required: ['id', 'userId', 'status'],
  properties: { id: { type: 'integer' }, userId: { type: 'integer' }, status: { type: 'string', enum: ['placed', 'shipped', 'delivered'] }, total: { type: 'number' }, createdAt: { type: 'string', format: 'date-time' } },
};
const idParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'integer', minimum: 1 } });
const ok = (schema: unknown) => ({ '200': { description: 'OK', content: { 'application/json': { schema } } } });

/** The demo API's OpenAPI 3.0 document. */
export function shopOpenApi(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Demo Shop API', version: '1.0.0', description: 'Products, customers, orders, order items and payments.' },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/products': {
        get: {
          operationId: 'getProducts',
          summary: 'List products',
          parameters: [
            { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: ok({ type: 'array', items: product }),
        },
        post: {
          operationId: 'createProduct',
          summary: 'Create a product',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number' }, stock: { type: 'integer' }, category: { type: 'string' } } } } } },
          responses: { '201': { description: 'Created', content: { 'application/json': { schema: product } } } },
        },
      },
      '/products/{id}': {
        parameters: [idParam('id', 'Product id')],
        get: { operationId: 'getProduct', summary: 'Get one product by id', responses: ok(product) },
        put: {
          operationId: 'updateProduct',
          summary: 'Update a product',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' }, stock: { type: 'integer' } } } } } },
          responses: ok(product),
        },
        delete: { operationId: 'deleteProduct', summary: 'Delete a product permanently', responses: ok({ type: 'object', properties: { deleted: { type: 'integer' } } }) },
      },
      '/users/{userId}': {
        get: {
          operationId: 'getUser',
          summary: 'Get a customer by id',
          parameters: [idParam('userId', 'Customer id')],
          responses: ok({ type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' }, tier: { type: 'string' } } }),
        },
      },
      '/users/{userId}/orders': {
        get: { operationId: 'getOrders', summary: "List a customer's orders", parameters: [idParam('userId', 'Customer id')], responses: ok({ type: 'array', items: order }) },
      },
      '/orders': {
        get: { operationId: 'listOrders', summary: 'List recent orders', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'array', items: order }) },
      },
      '/orders/{orderId}': {
        get: { operationId: 'getOrder', summary: 'Get one order', parameters: [idParam('orderId', 'Order id')], responses: ok(order) },
      },
      '/orders/{orderId}/items': {
        get: {
          operationId: 'getOrderItems',
          summary: 'List the line items of an order',
          parameters: [idParam('orderId', 'Order id')],
          responses: ok({ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, orderId: { type: 'integer' }, productId: { type: 'integer' }, quantity: { type: 'integer' }, unitPrice: { type: 'number' } } } }),
        },
      },
      '/orders/{orderId}/payments': {
        get: {
          operationId: 'getPayments',
          summary: 'List payments for an order, including payment status',
          parameters: [idParam('orderId', 'Order id')],
          responses: ok({ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, orderId: { type: 'integer' }, status: { type: 'string' }, amount: { type: 'number' }, method: { type: 'string' } } } }),
        },
      },
    },
  };
}
