import type { ErrorCode } from './types.js';

/** An error whose message is safe to show to the agent and to end users. */
export class ToolsmithError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'internal',
    /** What the user should do next. Printed by the CLI. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ToolsmithError';
  }
}

export class ConfigError extends ToolsmithError {
  constructor(message: string, hint?: string) {
    super(message, 'validation', hint);
    this.name = 'ConfigError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
