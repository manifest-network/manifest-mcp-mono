import type {
  AppDeploySpec,
  CosmosClientManager,
  SkuIntent,
} from '@manifest-network/manifest-mcp-core';
import {
  asProviderUuid,
  asSkuUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  type BuildManifestOptions,
  buildManifest,
  buildStackManifest,
  validateServiceName,
} from '../manifest.js';
import type { DeployAppResult } from './deployManifest.js';
import { type DeployCallOptions, deployManifest } from './deployManifest.js';

export type { DeployAppResult, DeployCallOptions } from './deployManifest.js';

import type { ServiceConfig } from '@manifest-network/manifest-mcp-core';

export type { ServiceConfig };

/** Data-only deploy spec for a high-level app deployment (spec §5.1). Public name kept for compatibility. */
export type DeployAppInput = AppDeploySpec;

function skuSelectorFromInput(input: AppDeploySpec): SkuIntent {
  const skuUuid = input.skuUuid?.trim();
  const providerUuid = input.providerUuid?.trim();
  // `resolved` requires BOTH ids — only then can fred skip the lookup.
  if (skuUuid && providerUuid) {
    return {
      kind: 'resolved',
      skuUuid: asSkuUuid(skuUuid),
      providerUuid: asProviderUuid(providerUuid),
    };
  }
  // Otherwise resolve by name, carrying whichever disambiguator we have so
  // core.resolveSku can narrow (provider) or pin (skuUuid → learns provider).
  // byName disambiguators are narrowing hints (non-UUID sentinels in tests, e.g. 'p2'/'b') —
  // chain resolves authoritatively, so trust-cast (as*), never parse*.
  return {
    kind: 'byName',
    size: input.size,
    ...(providerUuid ? { providerUuid: asProviderUuid(providerUuid) } : {}),
    ...(skuUuid ? { skuUuid: asSkuUuid(skuUuid) } : {}),
  };
}

export async function deployApp(
  clientManager: CosmosClientManager,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  getLeaseDataAuthToken: (
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ) => Promise<string>,
  spec: AppDeploySpec,
  callOptions: DeployCallOptions,
  fetchFn?: typeof globalThis.fetch,
): Promise<DeployAppResult> {
  // Validate mutually exclusive inputs
  if (spec.image && spec.services) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'image and services are mutually exclusive',
    );
  }
  if (!spec.image && !spec.services) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'either image or services is required',
    );
  }
  if (spec.image && !spec.port) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'port is required when using image',
    );
  }

  // Build manifest from typed input. The customDomain/serviceName
  // coherence checks now live in deployManifest, which derives them from
  // the manifest it receives (single-service vs stack) — so we just emit
  // the manifest JSON here and delegate.
  let manifestJson: string;
  if (spec.services) {
    for (const name of Object.keys(spec.services)) {
      if (!validateServiceName(name)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid service name: "${name}". Must be 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`,
        );
      }
    }

    const services: Record<string, BuildManifestOptions> = {};
    for (const [name, svc] of Object.entries(spec.services)) {
      services[name] = {
        image: svc.image,
        ports: svc.ports ?? {},
        env: svc.env,
        command: svc.command,
        args: svc.args,
        user: svc.user,
        tmpfs: svc.tmpfs,
        health_check: svc.health_check,
        stop_grace_period: svc.stop_grace_period,
        depends_on: svc.depends_on,
        expose: svc.expose,
        labels: svc.labels,
      };
    }
    manifestJson = JSON.stringify(buildStackManifest({ services }));
  } else {
    // image is guaranteed defined here: the guard above ensures !image && !services is false,
    // and the if-branch handles the services case. TypeScript can't narrow across if/else.
    const image = spec.image as string;
    manifestJson = JSON.stringify(
      buildManifest({
        image,
        ports: { [`${spec.port}/tcp`]: {} },
        env: spec.env,
        command: spec.command,
        args: spec.args,
        user: spec.user,
        tmpfs: spec.tmpfs,
        health_check: spec.health_check,
        stop_grace_period: spec.stop_grace_period,
        init: spec.init,
        expose: spec.expose,
        labels: spec.labels,
        depends_on: spec.depends_on,
      }),
    );
  }

  return deployManifest(
    {
      manifest: manifestJson,
      sku: skuSelectorFromInput(spec),
      storage: spec.storage,
      customDomain: spec.customDomain,
      serviceName: spec.serviceName,
    },
    callOptions,
    { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn },
  );
}
