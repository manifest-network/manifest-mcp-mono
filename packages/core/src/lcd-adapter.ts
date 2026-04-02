import { toBase64 } from '@cosmjs/encoding';
import {
  cosmos,
  cosmwasm as cosmwasmNs,
  liftedinit,
} from '@manifest-network/manifestjs';
import type { ManifestQueryClient } from './client.js';
import { logger } from './logger.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

function snakeToCamel(s: string): string {
  return s.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
}

function snakeToCamelDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamelDeep);
  }
  if (
    obj !== null &&
    typeof obj === 'object' &&
    !(obj instanceof Date) &&
    !(obj instanceof Uint8Array)
  ) {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        snakeToCamel(k),
        snakeToCamelDeep(v),
      ]),
    );
  }
  return obj;
}

function ucFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Converter {
  fromJSON(object: unknown): unknown;
}

function findConverter(
  namespace: Record<string, unknown>,
  methodName: string,
): Converter {
  const uc = ucFirst(methodName);
  const queryName = `Query${uc}Response`;
  const plainName = `${uc}Response`;

  const converter = (namespace[queryName] ?? namespace[plainName]) as
    | Converter
    | undefined;
  if (!converter?.fromJSON) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `No response converter found for method "${methodName}" (tried "${queryName}" and "${plainName}")`,
    );
  }
  return converter;
}

type AsyncFn = (...args: unknown[]) => Promise<unknown>;

function adaptModule(
  lcdMod: unknown,
  converterNs: unknown,
): Record<string, AsyncFn> {
  const lcdModule = lcdMod as Record<string, unknown>;
  const converterNamespace = converterNs as Record<string, unknown>;
  const adapted: Record<string, AsyncFn> = {};

  for (const key of Object.keys(lcdModule)) {
    if (key === 'req' || typeof lcdModule[key] !== 'function') continue;

    const originalFn = lcdModule[key] as AsyncFn;
    const converter = findConverter(converterNamespace, key);

    adapted[key] = async (...args: unknown[]) => {
      let sdkResult: unknown;
      try {
        sdkResult = await originalFn.call(lcdModule, ...args);
      } catch (error) {
        if (error instanceof ManifestMCPError) throw error;
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `LCD query "${key}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const camelCased = snakeToCamelDeep(sdkResult);
      try {
        return converter.fromJSON(camelCased);
      } catch (error) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Failed to convert LCD response for "${key}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
  }

  return adapted;
}

function unsupportedModule(modulePath: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.UNSUPPORTED_QUERY,
            `Module "${modulePath}" is not available via LCD/REST. Use an RPC endpoint instead.`,
          );
        }
        return undefined;
      },
    },
  );
}

/**
 * The generated LCD client interpolates `queryData` (Uint8Array) directly into
 * the URL path via template literal, producing comma-separated byte values
 * (e.g. `smart/123,34,99,...`) instead of base64. The REST API expects base64.
 * Patch the methods to convert queryData before the URL is constructed.
 */
function patchWasmQueryData(wasmLcd: unknown): Record<string, unknown> {
  const mod = wasmLcd as Record<string, unknown>;
  const patched: Record<string, unknown> = { ...mod };
  for (const method of ['smartContractState', 'rawContractState']) {
    const original = mod[method] as (
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    if (typeof original !== 'function') {
      logger.warn(
        `patchWasmQueryData: expected method "${method}" not found on wasm LCD module. Wasm queries may fail with malformed URLs.`,
      );
      continue;
    }
    patched[method] = (params: Record<string, unknown>) => {
      const queryData = params.queryData;
      return original.call(mod, {
        ...params,
        queryData:
          queryData instanceof Uint8Array ? toBase64(queryData) : queryData,
      });
    };
  }
  return patched;
}

export async function createLCDQueryClient(
  restEndpoint: string,
): Promise<ManifestQueryClient> {
  let lcd: Awaited<ReturnType<typeof liftedinit.ClientFactory.createLCDClient>>;
  let cosmwasmLcd: Awaited<
    ReturnType<typeof cosmwasmNs.ClientFactory.createLCDClient>
  >;
  try {
    [lcd, cosmwasmLcd] = await Promise.all([
      liftedinit.ClientFactory.createLCDClient({ restEndpoint }),
      cosmwasmNs.ClientFactory.createLCDClient({ restEndpoint }),
    ]);
  } catch (error) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      `Failed to create LCD client for ${restEndpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return {
      cosmos: {
        auth: {
          v1beta1: adaptModule(lcd.cosmos.auth.v1beta1, cosmos.auth.v1beta1),
        },
        authz: {
          v1beta1: adaptModule(lcd.cosmos.authz.v1beta1, cosmos.authz.v1beta1),
        },
        bank: {
          v1beta1: adaptModule(lcd.cosmos.bank.v1beta1, cosmos.bank.v1beta1),
        },
        base: {
          node: {
            v1beta1: adaptModule(
              lcd.cosmos.base.node.v1beta1,
              cosmos.base.node.v1beta1,
            ),
          },
        },
        circuit: { v1: adaptModule(lcd.cosmos.circuit.v1, cosmos.circuit.v1) },
        consensus: {
          v1: adaptModule(lcd.cosmos.consensus.v1, cosmos.consensus.v1),
        },
        distribution: {
          v1beta1: adaptModule(
            lcd.cosmos.distribution.v1beta1,
            cosmos.distribution.v1beta1,
          ),
        },
        feegrant: {
          v1beta1: adaptModule(
            lcd.cosmos.feegrant.v1beta1,
            cosmos.feegrant.v1beta1,
          ),
        },
        gov: {
          v1: adaptModule(lcd.cosmos.gov.v1, cosmos.gov.v1),
          v1beta1: adaptModule(lcd.cosmos.gov.v1beta1, cosmos.gov.v1beta1),
        },
        group: { v1: adaptModule(lcd.cosmos.group.v1, cosmos.group.v1) },
        mint: {
          v1beta1: adaptModule(lcd.cosmos.mint.v1beta1, cosmos.mint.v1beta1),
        },
        orm: {
          query: { v1alpha1: unsupportedModule('cosmos.orm.query.v1alpha1') },
        },
        params: {
          v1beta1: adaptModule(
            lcd.cosmos.params.v1beta1,
            cosmos.params.v1beta1,
          ),
        },
        staking: {
          v1beta1: adaptModule(
            lcd.cosmos.staking.v1beta1,
            cosmos.staking.v1beta1,
          ),
        },
        tx: { v1beta1: adaptModule(lcd.cosmos.tx.v1beta1, cosmos.tx.v1beta1) },
        upgrade: {
          v1beta1: adaptModule(
            lcd.cosmos.upgrade.v1beta1,
            cosmos.upgrade.v1beta1,
          ),
        },
      },
      liftedinit: {
        billing: {
          v1: adaptModule(lcd.liftedinit.billing.v1, liftedinit.billing.v1),
        },
        manifest: { v1: unsupportedModule('liftedinit.manifest.v1') },
        sku: { v1: adaptModule(lcd.liftedinit.sku.v1, liftedinit.sku.v1) },
      },
      cosmwasm: {
        wasm: {
          v1: adaptModule(
            patchWasmQueryData(cosmwasmLcd.cosmwasm.wasm.v1),
            cosmwasmNs.wasm.v1,
          ),
        },
      },
    } as ManifestQueryClient;
  } catch (error) {
    if (error instanceof ManifestMCPError) throw error;
    throw new ManifestMCPError(
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      `Failed to adapt LCD modules: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Re-export for testing
export {
  adaptModule as _adaptModule,
  findConverter as _findConverter,
  patchWasmQueryData as _patchWasmQueryData,
  snakeToCamelDeep as _snakeToCamelDeep,
  unsupportedModule as _unsupportedModule,
};
