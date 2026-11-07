import { describe, expect, it } from 'vitest';
import { LlmStage, extractedToOpenApi, type ExtractedApi } from '../../src/llm/llm.js';
import { importOpenApi } from '../../src/openapi/import.js';
import { approveShop, makeHarness } from '../helpers.js';

type Call = {
  model: string;
  output_config: { effort: string };
  betas: string[];
  fallbacks: string;
  system: string;
  messages: Array<{ content: string }>;
};

function fakeClient(reply: (c: Call) => unknown, stop = 'end_turn') {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      beta: {
        messages: {
          parse: async (c: Call) => (
            calls.push(c),
            {
              stop_reason: stop,
              stop_details: stop === 'refusal' ? { category: 'cyber' } : null,
              parsed_output: reply(c),
            }
          ),
        },
      },
    } as never,
  };
}

const extracted: ExtractedApi = {
  title: 'Weather',
  baseUrl: 'https://api.weather.example.com',
  endpoints: [
    {
      name: 'getForecast',
      description: 'Forecast for a city',
      method: 'GET',
      path: '/forecast/:city',
      requiredParameters: [
        { name: 'city', in: 'path', type: 'string', description: 'City', example: 'Riyadh' },
      ],
      optionalParameters: [
        { name: 'days', in: 'query', type: 'integer', description: 'Days', example: '3' },
      ],
    },
    {
      name: 'createAlert',
      description: 'Create an alert',
      method: 'POST',
      path: '/alerts',
      requiredParameters: [
        { name: 'city', in: 'body', type: 'string', description: 'City', example: null },
      ],
      optionalParameters: [],
    },
  ],
};

describe('optional LLM stage', () => {
  it('sends the configured model and effort, with refusal fallbacks, and treats docs as data', async () => {
    const f = fakeClient(() => extracted);
    const stage = new LlmStage({ model: 'claude-opus-5-5', effort: 'medium', client: f.client });
    const out = await stage.extractEndpoints('GET /forecast/:city ...', { name: 'weather' });
    expect(out.endpoints).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(f.calls[0]!.system).toMatch(/Never invent endpoints/);
    expect(f.calls[0]!.messages[0]!.content).toMatch(/<documentation>/);
  });

  it('surfaces refusals and oversized input as errors, not silent results', async () => {
    const refused = new LlmStage({
      model: 'm',
      effort: 'low',
      client: fakeClient(() => null, 'refusal').client,
    });
    await expect(refused.extractEndpoints('x', { name: 'w' })).rejects.toThrow(/declined.*cyber/);
    const stage = new LlmStage({
      model: 'm',
      effort: 'low',
      client: fakeClient(() => extracted).client,
    });
    await expect(stage.extractEndpoints('x'.repeat(400_001), { name: 'w' })).rejects.toThrow(
      /limit is 400000/,
    );
  });

  it('extracted endpoints become a normal spec with typed params and examples', async () => {
    const def = await importOpenApi(extractedToOpenApi(extracted), { name: 'weather' });
    const by = Object.fromEntries(def.operations.map((o) => [o.name, o]));
    expect(by.getForecast!.path).toBe('/forecast/{city}');
    expect(by.getForecast!.params.find((p) => p.name === 'days')).toMatchObject({
      example: 3,
      schema: { type: 'integer' },
    });
    expect(by.createAlert!.inputSchema).toMatchObject({ required: ['body'] });
    expect(by.createAlert!.access).toBe('write');
  });

  it('capability fallback keeps only real, allowed tool names', async () => {
    const h = await makeHarness({ config: { llm: { enabled: true } } });
    try {
      await approveShop(h.app);
      const f = fakeClient(() => ({
        possible: true,
        explanation: 'x',
        tools: [
          { name: 'shop__getProducts', why: 'stock is in products' },
          { name: 'shop__inventedTool', why: 'nope' },
        ],
      }));
      h.app.setLlmStage(
        new LlmStage({ model: 'claude-opus-5-5', effort: 'medium', client: f.client }),
      );
      const a = await h.app.analyzeCapability('what is left in the warehouse', 's');
      expect(a.verdict).toBe('available');
      expect(
        (a as { llm: { tools: Array<{ name: string }> } }).llm.tools.map((t) => t.name),
      ).toEqual(['shop__getProducts']);
      expect(f.calls[0]!.messages[0]!.content).toMatch(/shop__getOrders/); // the real catalog was sent
      // keyword-resolvable requests never call the model
      await h.app.analyzeCapability('show the payments for an order', 's');
      expect(f.calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('docs import is refused while the stage is off', async () => {
    const h = await makeHarness({
      importNow: false,
      integration: { type: 'docs', spec: 'README.md', baseUrl: 'https://x.example' },
    });
    try {
      await expect(h.app.importIntegration('shop', 'human:test')).rejects.toThrow(
        /needs the optional LLM stage/,
      );
    } finally {
      await h.close();
    }
  });
});
