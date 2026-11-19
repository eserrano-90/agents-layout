/**
 * Client tokens: who may send events to this server.
 *
 * Issued tokens are stored in ~/.pixel-agents/client-tokens.json as SHA-256
 * hashes only (mode 0600); the secret is shown once when issued. A token is
 * bound to the first client id that uses it, so it cannot later be used to
 * impersonate another client. The co-located client of all-in-one mode uses an
 * ephemeral in-memory token that is never written anywhere.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CLIENT_TOKENS_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';

export interface IssuedToken {
  /** Short public identifier, safe to list. */
  id: string;
  label: string;
  /** SHA-256 hex of the secret. */
  hash: string;
  /** Client id bound on first use. */
  clientId?: string;
  createdAt: number;
}

export interface TokenMatch {
  tokenId: string;
  label: string;
  /** Client id this token is bound to (undefined until first use). */
  clientId?: string;
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function defaultTokensFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CLIENT_TOKENS_FILE_NAME);
}

export class ClientTokenStore {
  private readonly ephemeral = new Map<string, TokenMatch>(); // hash -> match

  constructor(private readonly filePath: string = defaultTokensFilePath()) {}

  /** Register an in-memory token (all-in-one mode). Returns the secret. */
  addEphemeral(label: string): string {
    const secret = crypto.randomBytes(24).toString('base64url');
    this.ephemeral.set(hashSecret(secret), { tokenId: 'local', label });
    return secret;
  }

  /** Issue a persistent token. Returns the secret, which is not stored. */
  issue(label: string): { id: string; secret: string } {
    const secret = crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomBytes(4).toString('hex');
    const tokens = this.read();
    tokens.push({ id, label, hash: hashSecret(secret), createdAt: Date.now() });
    this.write(tokens);
    return { id, secret };
  }

  /** Issued tokens, without their hashes. */
  list(): Array<Omit<IssuedToken, 'hash'>> {
    return this.read().map(({ hash: _hash, ...rest }) => rest);
  }

  /** Revoke an issued token by id or label. Returns true when one was removed. */
  revoke(idOrLabel: string): boolean {
    const tokens = this.read();
    const kept = tokens.filter((t) => t.id !== idOrLabel && t.label !== idOrLabel);
    if (kept.length === tokens.length) return false;
    this.write(kept);
    return true;
  }

  /** Resolve a bearer secret. Re-reads the file so revocations apply immediately. */
  verify(secret: string): TokenMatch | null {
    if (!secret) return null;
    const hash = hashSecret(secret);
    for (const [h, match] of this.ephemeral) {
      if (sameHash(h, hash)) return match;
    }
    for (const t of this.read()) {
      if (sameHash(t.hash, hash)) return { tokenId: t.id, label: t.label, clientId: t.clientId };
    }
    return null;
  }

  /** Bind a token to the client id that used it first. */
  bind(match: TokenMatch, clientId: string): void {
    if (match.tokenId === 'local') {
      for (const m of this.ephemeral.values()) if (m === match) m.clientId = clientId;
      return;
    }
    const tokens = this.read();
    const t = tokens.find((x) => x.id === match.tokenId);
    if (t && !t.clientId) {
      t.clientId = clientId;
      this.write(tokens);
    }
    match.clientId = clientId;
  }

  private read(): IssuedToken[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { tokens?: IssuedToken[] };
      return Array.isArray(raw.tokens) ? raw.tokens : [];
    } catch {
      return [];
    }
  }

  private write(tokens: IssuedToken[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
