import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { SessionData } from './types.js';

const SESSION_PATH = join(homedir(), '.manifest', 'session.json');

export function getSessionPath(): string {
  return SESSION_PATH;
}

export function loadSession(): SessionData | null {
  try {
    const raw = readFileSync(SESSION_PATH, 'utf-8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionData): void {
  const dir = dirname(SESSION_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function deleteSession(): boolean {
  try {
    unlinkSync(SESSION_PATH);
    return true;
  } catch {
    return false;
  }
}
