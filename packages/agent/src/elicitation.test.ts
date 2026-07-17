import type { SkuCandidate } from '@manifest-network/manifest-agent-core';
import {
  asProviderUuid,
  asSkuUuid,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import { buildSkuPickSchema, parseSkuChoice } from './elicitation.js';

const cands: SkuCandidate[] = [
  {
    skuUuid: asSkuUuid('a'),
    providerUuid: asProviderUuid('p1'),
    name: 'docker-micro',
    price: { amount: '100', denom: 'umfx' },
    active: true,
  },
  {
    skuUuid: asSkuUuid('b'),
    providerUuid: asProviderUuid('p2'),
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

  it('sanitizes control chars so a hostile SKU cannot inject into the label (ENG-555)', () => {
    const hostile: SkuCandidate[] = [
      {
        skuUuid: asSkuUuid('x'),
        providerUuid: asProviderUuid('p\n1'),
        name: 'docker-micro\n  FREE TIER',
        price: { amount: '1\n0', denom: 'umfx\nx' },
        active: true,
      },
    ];
    const s = buildSkuPickSchema(hostile) as unknown as {
      properties: { sku_uuid: { enumNames: string[] } };
    };
    // the host renders these labels — a newline would let the SKU forge extra lines
    expect(s.properties.sku_uuid.enumNames[0]).not.toMatch(/[\n\r]/);
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
    expect(() => parseSkuChoice({ action: 'cancel' }, cands)).toThrow(
      expect.objectContaining({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      }),
    );
  });

  it('throws OPERATION_CANCELLED on decline', () => {
    expect(() => parseSkuChoice({ action: 'decline' }, cands)).toThrow(
      expect.objectContaining({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      }),
    );
  });

  it('rejects an unknown uuid with INVALID_CONFIG', () => {
    expect(() =>
      parseSkuChoice({ action: 'accept', content: { sku_uuid: 'zzz' } }, cands),
    ).toThrow(
      expect.objectContaining({ code: ManifestMCPErrorCode.INVALID_CONFIG }),
    );
  });
});
