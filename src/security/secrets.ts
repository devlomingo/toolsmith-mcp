import { ConfigError } from '../core/errors.js';

const REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve `${env:NAME}` references. Secrets are only ever referenced in
 * config, never stored in it or in the database; resolution happens at the
 * moment of use so a rotated variable takes effect on restart.
 */
export function resolveEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(REF, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') {
      throw new ConfigError(
        `Environment variable ${name} is not set`,
        `Set it in your shell or in a .env file next to toolsmith.config.json, e.g. ${name}=...`,
      );
    }
    return v;
  });
}

export function hasEnvRef(value: string): boolean {
  REF.lastIndex = 0;
  return REF.test(value);
}

export function envRefNames(value: string): string[] {
  return [...value.matchAll(REF)].map((m) => m[1]!);
}
