import type { SkuCandidate } from '@manifest-network/manifest-agent-core';
import { describe, expect, it } from 'vitest';
import { buildSkuPickSchema, parseSkuChoice } from './elicitation.js';

const cands: SkuCandidate[] = [
  {
    skuUuid: 'a',
    providerUuid: 'p1',
    name: 'docker-micro',
    price: { amount: '100', denom: 'umfx' },
    active: true,
  },
  {
    skuUuid: 'b',
    providerUuid: 'p2',
    name: 'docker-micro',
    price: { amount: '120', denom: 'umfx' },
    active: true,
  },
];

describe('buildSkuPickSchema', () => {
  it('enumerates sku uuids with human labels', () => {
    const s = buildSkuPickSchema(cands) as unknown as {
      properties: { sku_uuid: { enum: string[]; enumNames: string[] } };
    };
    expect(s.properties.sku_uuid.enum).toEqual(['a', 'b']);
    expect(s.properties.sku_uuid.enumNames[0]).toContain('p1');
  });

  it('includes price suffix in enumNames when price is present', () => {
    const s = buildSkuPickSchema(cands) as unknown as {
      properties: { sku_uuid: { enumNames: string[] } };
    };
    expect(s.properties.sku_uuid.enumNames[0]).toContain('100umfx');
  });
});

describe('parseSkuChoice', () => {
  it('returns the chosen skuUuid + providerUuid', () => {
    const pick = parseSkuChoice(
      { action: 'accept', content: { sku_uuid: 'b' } },
      cands,
    );
    expect(pick).toEqual({ skuUuid: 'b', providerUuid: 'p2' });
  });

  it('throws OPERATION_CANCELLED on dismiss (no on-chain state yet)', () => {
    expect(() => parseSkuChoice({ action: 'cancel' }, cands)).toThrow();
  });

  it('throws OPERATION_CANCELLED on decline', () => {
    expect(() => parseSkuChoice({ action: 'decline' }, cands)).toThrow();
  });

  it('rejects an unknown uuid', () => {
    expect(() =>
      parseSkuChoice({ action: 'accept', content: { sku_uuid: 'zzz' } }, cands),
    ).toThrow();
  });
});
