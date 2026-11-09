import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { fileURLToPath } from 'node:url';

export const PROTO = fileURLToPath(new URL('./grpc/shop.proto', import.meta.url));
export const GRPC_TOKEN = 'grpc-secret-token-123';

interface Order {
  id: string;
  user_id: string;
  status: string;
}

/** A shop over gRPC with bearer auth and server reflection, on a random loopback port. */
export async function startGrpcShop(opts: { reflection?: boolean } = {}) {
  const def = protoLoader.loadSync(PROTO, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    demo: { shop: { v1: { ShopService: grpc.ServiceClientConstructor } } };
  };
  const orders: Order[] = [];
  for (let u = 1; u <= 20; u++)
    for (let k = 0; k < 3; k++)
      orders.push({ id: String(u * 100 + k), user_id: String(u), status: k ? 'shipped' : 'new' });
  let calls = 0;
  const authed = (
    call: grpc.ServerUnaryCall<unknown, unknown> | grpc.ServerWritableStream<unknown, unknown>,
  ) => {
    calls++;
    const auth = call.metadata.get('authorization')[0];
    return auth === `Bearer ${GRPC_TOKEN}`;
  };
  const unauth = { code: grpc.status.UNAUTHENTICATED, details: 'bad token' };
  const server = new grpc.Server();
  server.addService(pkg.demo.shop.v1.ShopService.service, {
    GetUser(
      call: grpc.ServerUnaryCall<{ user_id: string }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) {
      if (!authed(call)) return cb(unauth);
      const id = Number(call.request.user_id);
      if (!(id >= 1 && id <= 20))
        return cb({ code: grpc.status.NOT_FOUND, details: `no user ${id}` });
      cb(null, {
        id: String(id),
        name: `User ${id}`,
        tier: id % 2 ? 'TIER_GOLD' : 'TIER_SILVER',
        created_at: { seconds: String(1_700_000_000 + id), nanos: 0 },
        labels: { region: 'eu' },
      });
    },
    ListOrders(
      call: grpc.ServerUnaryCall<{ user_id: string }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) {
      if (!authed(call)) return cb(unauth);
      cb(null, {
        orders: orders.filter((o) => o.user_id === String(Number(call.request.user_id))),
      });
    },
    GetOrderItems(
      call: grpc.ServerUnaryCall<{ order_id: string }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) {
      if (!authed(call)) return cb(unauth);
      const id = Number(call.request.order_id);
      cb(null, { items: [{ sku: `sku-${id}`, quantity: (id % 3) + 1 }] });
    },
    WatchOrders(call: grpc.ServerWritableStream<{ user_id: string }, unknown>) {
      if (!authed(call)) return call.destroy(Object.assign(new Error('bad token'), unauth));
      for (let i = 0; i < 500 && !call.cancelled; i++)
        call.write({ id: String(i), user_id: call.request.user_id, status: 'new' });
      call.end();
    },
    PlaceOrder(
      call: grpc.ServerUnaryCall<{ user_id: string }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) {
      if (!authed(call)) return cb(unauth);
      // Echoes the credential in an error, to prove the gateway scrubs it.
      if (call.request.user_id === '666')
        return cb({
          code: grpc.status.INVALID_ARGUMENT,
          details: `rejected for ${call.metadata.get('authorization')[0]}`,
        });
      cb(null, { id: '9999', user_id: call.request.user_id, status: 'new' });
    },
    DeleteOrder(call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) {
      if (!authed(call)) return cb(unauth);
      cb(null, { deleted: true });
    },
    WatchSlow(call: grpc.ServerWritableStream<{ user_id: string }, unknown>) {
      if (!authed(call)) return call.destroy(Object.assign(new Error('bad token'), unauth));
      let i = 0;
      const t = setInterval(() => {
        if (call.cancelled) return clearInterval(t);
        if (call.request.user_id === '0') return; // a stream that never sends
        call.write({ id: String(i++), user_id: call.request.user_id, status: 'new' });
      }, 100);
      call.on('cancelled', () => clearInterval(t));
    },
    ListBlobs(call: grpc.ServerWritableStream<unknown, unknown>) {
      if (!authed(call)) return call.destroy(Object.assign(new Error('bad token'), unauth));
      const blob = Buffer.alloc(3 * 1024 * 1024, 7);
      for (let i = 0; i < 30 && !call.cancelled; i++) call.write({ data: blob });
      call.end();
    },
    GetNickname(call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) {
      if (!authed(call)) return cb(unauth);
      cb(null, { value: 'shopper' });
    },
    Upload(_call: unknown, cb: grpc.sendUnaryData<unknown>) {
      cb(null, { deleted: false });
    },
  });
  if (opts.reflection) new ReflectionService(def).addToServer(server);
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? rej(e) : res(p),
    ),
  );
  return {
    address: `127.0.0.1:${port}`,
    get calls() {
      return calls;
    },
    stop: () => new Promise<void>((r) => server.tryShutdown(() => r())),
  };
}
