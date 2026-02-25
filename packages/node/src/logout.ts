import { deleteSession, getSessionPath } from './web3auth/index.js';

export async function runLogout(): Promise<void> {
  const removed = deleteSession();
  if (removed) {
    console.error(`Session removed: ${getSessionPath()}`);
  } else {
    console.error('No active session found.');
  }
}
