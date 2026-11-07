import type { AccessLevel, JsonSchema } from '../core/types.js';

export type ParamLocation = 'path' | 'query' | 'header' | 'cookie';

export interface OperationParam {
  name: string;
  in: ParamLocation;
  required: boolean;
  schema: JsonSchema;
  description?: string;
}

/** One API operation, fully resolved. Stored in the registry as-is. */
export interface OperationDef {
  /** Short tool name without the integration prefix, e.g. getProduct. */
  name: string;
  operationId?: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  params: OperationParam[];
  body?: { required: boolean; contentType: string; schema: JsonSchema };
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** True when a non-object response was wrapped as { result }. */
  outputWrapped: boolean;
  access: AccessLevel;
  tags: string[];
}

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface SpecFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  operation?: string;
}

/** What is stored as the definition of an `openapi` registry artifact. */
export interface OpenApiIntegrationDef {
  kind: 'openapi';
  name: string;
  title: string;
  description: string;
  specSource: string;
  specVersion: string;
  baseUrl: string;
  operations: OperationDef[];
  findings: SpecFinding[];
}
