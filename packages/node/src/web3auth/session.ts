import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { SessionData } from './types.js';

const SESSION_PATH = join(homedir(), '.manifest', 'session.json');

export function getSessionPath(): string {
  return SESSION_PATH;
}

function isValidSession(data: unknown): data is SessionData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.privateKeyHex === 'string' && obj.privateKeyHex.length > 0 &&
    typeof obj.verifierId === 'string' &&
    typeof obj.idToken === 'string' &&
    typeof obj.address === 'string'
  );
}

export function loadSession(): SessionData | null {
  let raw: string;
  try {
    raw = readFileSync(SESSION_PATH, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `Failed to read session file at ${SESSION_PATH}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Check file permissions or remove the file and run "manifest-mcp-node login" again.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `Session file at ${SESSION_PATH} contains invalid JSON and may be corrupted. ` +
      `Remove it and run "manifest-mcp-node login" again. Parse error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!isValidSession(parsed)) {
    throw new Error(
      `Session file at ${SESSION_PATH} has an invalid format (missing required fields). ` +
      'Remove it and run "manifest-mcp-node login" again.'
    );
  }

  return parsed;
}

export function saveSession(session: SessionData): void {
  const dir = dirname(SESSION_PATH);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    throw new Error(
      `Failed to create session directory at ${dir}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Check that you have write permissions to your home directory.'
    );
  }
  try {
    writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
  } catch (err: unknown) {
    throw new Error(
      `Failed to write session file to ${SESSION_PATH}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Ensure you have write permissions and sufficient disk space.'
    );
  }
}

export function deleteSession(): boolean {
  try {
    unlinkSync(SESSION_PATH);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(
      `Failed to delete session file at ${SESSION_PATH}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Check file permissions. The session file may still contain sensitive key material.'
    );
  }
}
