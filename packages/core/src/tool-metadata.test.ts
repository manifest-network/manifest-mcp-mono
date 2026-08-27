import { describe, expect, it } from 'vitest';
import { gasMultiplierSchema } from './tool-metadata.js';

describe('gasMultiplierSchema', () => {
  it('keeps every tool on the same optional, finite, minimum-one contract', () => {
    const schema = gasMultiplierSchema();

    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(0.99).success).toBe(false);
    expect(schema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('allows a caller-specific description without changing validation', () => {
    const schema = gasMultiplierSchema('Estimation override');

    expect(schema.description).toBe('Estimation override');
    expect(schema.safeParse(1.5).success).toBe(true);
  });
});
