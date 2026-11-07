import { ToolsmithError } from '../core/errors.js';

/**
 * Developer-provided endpoint definitions, for APIs that have no OpenAPI
 * document. Converted into a minimal OpenAPI 3.1 document so the rest of the
 * pipeline stays one code path.
 *
 * Text form, one endpoint per line:
 *   GET /products            List products
 *   GET /products/{id}       Get one product
 *   POST /products           Create a product
 */
export interface EndpointList {
  title?: string;
  baseUrl: string;
  endpoints: Array<{
    method: string;
    path: string;
    description?: string;
    query?: string[];
  }>;
}

export function parseEndpointText(text: string, baseUrl: string, title?: string): EndpointList {
  const endpoints: EndpointList['endpoints'] = [];
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/\S*)\s*(.*)$/i);
    if (!m) {
      throw new ToolsmithError(
        `Line ${i + 1} is not an endpoint: "${line}"`,
        'validation',
        'Use "METHOD /path  description", e.g. "GET /products/{id}  Get one product".',
      );
    }
    const [, method, pathWithQuery, description] = m;
    const [path, query] = pathWithQuery!.split('?');
    endpoints.push({
      method: method!.toUpperCase(),
      path: path!,
      description: description?.trim() || undefined,
      query: query
        ? query
            .split('&')
            .map((q) => q.split('=')[0]!)
            .filter(Boolean)
        : undefined,
    });
  }
  if (endpoints.length === 0)
    throw new ToolsmithError('No endpoints found in the definition', 'validation');
  return { title, baseUrl, endpoints };
}

export function endpointsToOpenApi(list: EndpointList): Record<string, unknown> {
  if (!/^https?:\/\//.test(list.baseUrl)) {
    throw new ToolsmithError('Endpoint definitions need an absolute base URL', 'validation');
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ep of list.endpoints) {
    const pathParams = [...ep.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const parameters = [
      ...pathParams.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...(ep.query ?? []).map((name) => ({
        name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
      })),
    ];
    const method = ep.method.toLowerCase();
    (paths[ep.path] ??= {})[method] = {
      summary: ep.description ?? `${ep.method} ${ep.path}`,
      parameters,
      ...(['post', 'put', 'patch'].includes(method)
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { type: 'object', additionalProperties: true } },
              },
            },
          }
        : {}),
      responses: { '200': { description: 'OK' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: list.title ?? 'Custom API', version: '0.0.0' },
    servers: [{ url: list.baseUrl }],
    paths,
  };
}
