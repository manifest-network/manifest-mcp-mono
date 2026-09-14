/** A transaction hash is exactly 64 ASCII hexadecimal characters; preserve its original case. */
export function isTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && !!value.match(/^[0-9a-fA-F]{64}$/);
}
