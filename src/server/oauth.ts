import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from 'jose';
import { createHash } from 'node:crypto';
import { ToolsmithError } from '../core/errors.js';
import type { OAuthResourceConfig } from '../config/config.js';
import { isLoopback } from './net.js';

/**
 * The gateway as an OAuth 2.1 resource server (MCP authorization spec):
 * clients present JWT access tokens issued by the operator's authorization
 * server. Tokens are checked locally against the issuer's JWKS: signature,
 * issuer, audience (this gateway's resource URL, RFC 8707), expiry, and
 * required scopes. Tokens are never passed on to upstream APIs.
 */
export interface OAuthGate {
  /** RFC 9728 metadata URL advertised in challenges. */
  metadataUrl: string;
  /** Paths the metadata document is served at. */
  metadataPaths: string[];
  metadata: Record<string, unknown>;
  /** Verified identity, or the challenge Response to send back. */
  authenticate(authorization: string | undefined): Promise<AuthInfo | Response>;
}

const FETCH_TIMEOUT_MS = 5_000;

function requireSecureUrl(raw: string, what: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    throw new ToolsmithError(
      `${what} must use https (plain http is allowed only on loopback): ${raw}`,
      'validation',
    );
  return url;
}

const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Find the issuer's jwks_uri from RFC 8414 or OpenID discovery metadata. */
export async function discoverJwksUri(issuer: string): Promise<string> {
  const base = issuer.replace(/\/$/, '');
  const iss = new URL(base);
  // RFC 8414 inserts the well-known segment before the issuer's path.
  const candidates = [
    `${iss.origin}/.well-known/oauth-authorization-server${iss.pathname === '/' ? '' : iss.pathname}`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    try {
      const res = await timedFetch(url);
      if (!res.ok) continue;
      const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
      // The document must describe the configured issuer (RFC 8414 §3.3).
      if (doc.issuer?.replace(/\/$/, '') !== base || !doc.jwks_uri) continue;
      requireSecureUrl(doc.jwks_uri, 'jwks_uri');
      return doc.jwks_uri;
    } catch (err) {
      if (err instanceof ToolsmithError) throw err;
    }
  }
  throw new ToolsmithError(
    `Could not discover the JWKS for issuer ${issuer}`,
    'network',
    'Check server.oauth.issuer, or set server.oauth.jwksUri explicitly.',
  );
}

function scopesOf(p: JWTPayload): string[] {
  if (typeof p.scope === 'string') return p.scope.split(' ').filter(Boolean);
  if (Array.isArray(p.scp)) return p.scp.filter((s): s is string => typeof s === 'string');
  return [];
}

/** The client app the token was issued to: client_id (RFC 9068), else azp. Never sub. */
function clientIdOf(p: JWTPayload): string | undefined {
  for (const k of ['client_id', 'azp'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// Errors that say the token is bad; anything else (JWKS unreachable, slow,
// or malformed) is the server's problem, and a 401 would only make clients
// re-authenticate in a loop.
const TOKEN_ERRORS = new Set([
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWK_INVALID',
]);

export async function createOAuthGate(cfg: OAuthResourceConfig): Promise<OAuthGate> {
  const issuer = requireSecureUrl(cfg.issuer, 'server.oauth.issuer').toString().replace(/\/$/, '');
  const resource = requireSecureUrl(cfg.resource, 'server.oauth.resource');
  const jwksUri = cfg.jwksUri
    ? requireSecureUrl(cfg.jwksUri, 'server.oauth.jwksUri').toString()
    : await discoverJwksUri(cfg.issuer);
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: FETCH_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    [customFetch]: (url: string, init: RequestInit) => fetch(url, { ...init, redirect: 'error' }),
  });
  const audiences = [resource.toString(), ...cfg.audiences];

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: [issuer, `${issuer}/`],
          audience: audiences,
          algorithms: cfg.algorithms,
          clockTolerance: 30,
          requiredClaims: ['exp'],
          ...(cfg.requireAtJwt ? { typ: 'at+jwt' } : {}),
        });
        const now = Math.floor(Date.now() / 1000);
        if (typeof payload.iat === 'number' && payload.iat > now + 30)
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token issued in the future');
        if (payload.exp! - now > cfg.maxLifetimeSeconds)
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token lifetime is too long');
        const clientId = clientIdOf(payload);
        const subject = typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined;
        if (!clientId && !subject)
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token names no client or subject');
        return {
          token,
          clientId: clientId ?? '',
          extra: { subject },
          scopes: scopesOf(payload),
          expiresAt: payload.exp,
          // jwtVerify checked the audience; report the resource it was issued for.
          resource,
        };
      } catch (err) {
        if (err instanceof OAuthError) throw err;
        if (err instanceof errors.JOSEError && TOKEN_ERRORS.has(err.code))
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
        // JWKS unreachable and similar: not the client's fault.
        throw new OAuthError(OAuthErrorCode.ServerError, 'Could not verify the access token');
      }
    },
  };

  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const metadataPath = new URL(metadataUrl).pathname;
  const options = {
    verifier,
    requiredScopes: cfg.requiredScopes,
    resourceMetadataUrl: metadataUrl,
    expectedResource: resource,
  };
  return {
    metadataUrl,
    metadataPaths: [...new Set([metadataPath, '/.well-known/oauth-protected-resource'])],
    metadata: {
      resource: resource.toString(),
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      ...(cfg.requiredScopes.length ? { scopes_supported: cfg.requiredScopes } : {}),
      resource_name: 'toolsmith-mcp',
    },
    async authenticate(authorization) {
      try {
        return await verifyBearerToken(authorization, options);
      } catch (err) {
        return bearerAuthChallengeResponse(err, options);
      }
    },
  };
}

const idHash = (v: string): string =>
  createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 24);

/**
 * The principal for a verified token: client app plus user. Both parts are
 * hashes of the complete claim values, so two ids that share a prefix never
 * merge, and a user's sub can never pose as a client id. A short readable
 * label from the client id is kept for logs; it plays no part in matching.
 */
export function oauthPrincipalName(clientId: string, subject: string | undefined): string {
  const label = clientId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'client';
  return `oauth:${label}.${clientId ? idHash(clientId) : '-'}/${subject ? idHash(subject) : '-'}`;
}

/** The client hash inside an OAuth principal name, or undefined. */
export function oauthClientHash(name: string): string | undefined {
  return /^oauth:[A-Za-z0-9._-]*\.([0-9a-f]{24})\/(?:[0-9a-f]{24}|-)$/.exec(name)?.[1];
}

export { idHash as oauthIdHash };
