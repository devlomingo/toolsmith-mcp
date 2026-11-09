import type { IntegrationConfig } from './config/config.js';
import type { JsonObject } from './core/types.js';
import { GrpcIntegrationClient } from './grpc/executor.js';
import { HttpIntegrationClient, type HttpOutcome } from './openapi/http-executor.js';
import type { OpenApiIntegrationDef, OperationDef } from './openapi/types.js';
import type { Redactor } from './security/redact.js';

/** What the gateway, evaluator and verifier need from an integration's executor. */
export interface IntegrationClient {
  call(op: OperationDef, args: JsonObject, signal?: AbortSignal): Promise<HttpOutcome>;
}

export function integrationClient(
  cfg: IntegrationConfig,
  def: OpenApiIntegrationDef,
  redactor: Redactor,
): IntegrationClient {
  if (cfg.type === 'grpc' || def.grpc) return new GrpcIntegrationClient(cfg, def, redactor);
  return new HttpIntegrationClient(cfg, cfg.baseUrl ?? def.baseUrl, redactor);
}
