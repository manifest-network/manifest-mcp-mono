import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type { PollOptions } from '../http/fred.js';
import {
  type BuildManifestOptions,
  buildManifest,
  buildStackManifest,
  validateServiceName,
} from '../manifest.js';
import type { DeployAppResult } from './deployManifest.js';
import { deployManifest } from './deployManifest.js';

export type { DeployAppResult } from './deployManifest.js';

export interface ServiceConfig {
  image: string;
  ports?: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  depends_on?: Record<string, { condition: string }>;
  expose?: string[];
  labels?: Record<string, string>;
}

export interface DeployAppInput {
  image?: string;
  port?: number;
  size: string;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  init?: boolean;
  expose?: string[];
  labels?: Record<string, string>;
  storage?: string;
  depends_on?: Record<string, { condition: string }>;
  services?: Record<string, ServiceConfig>;
  gasMultiplier?: number;
  /**
   * Optional FQDN to attach to the lease item once the create-lease tx
   * confirms. The set-domain tx is submitted after `onLeaseCreated` fires
   * and before the manifest upload, so providerd has the domain available
   * when it provisions the container. Failures here surface as the same
   * "Deploy partially succeeded: lease X was created..." error shape as
   * upload/poll failures — the caller can `close_lease` to clean up or
   * retry `set_item_custom_domain` standalone.
   */
  customDomain?: string;
  /**
   * Required when `customDomain` is set on a stack lease (i.e., `services`
   * is provided). Must match one of the keys in `services`. Omit for an
   * image+port single-item legacy lease.
   */
  serviceName?: string;
  /** Fires once after the create-lease TX confirms, before upload/poll. Awaited. Errors propagate. */
  onLeaseCreated?: (
    leaseUuid: string,
    providerUrl: string,
  ) => void | Promise<void>;
  /** Aborts upload and poll (not the already-submitted chain TX). */
  abortSignal?: AbortSignal;
  /** Forwarded to the internal pollLeaseUntilReady call. abortSignal is the top-level field above. */
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

export async function deployApp(
  clientManager: CosmosClientManager,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  getLeaseDataAuthToken: (
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ) => Promise<string>,
  input: DeployAppInput,
  fetchFn?: typeof globalThis.fetch,
): Promise<DeployAppResult> {
  // Validate mutually exclusive inputs
  if (input.image && input.services) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'image and services are mutually exclusive',
    );
  }
  if (!input.image && !input.services) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'either image or services is required',
    );
  }
  if (input.image && !input.port) {
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
  if (input.services) {
    for (const name of Object.keys(input.services)) {
      if (!validateServiceName(name)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid service name: "${name}". Must be 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`,
        );
      }
    }

    const services: Record<string, BuildManifestOptions> = {};
    for (const [name, svc] of Object.entries(input.services)) {
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
    const image = input.image as string;
    manifestJson = JSON.stringify(
      buildManifest({
        image,
        ports: { [`${input.port}/tcp`]: {} },
        env: input.env,
        command: input.command,
        args: input.args,
        user: input.user,
        tmpfs: input.tmpfs,
        health_check: input.health_check,
        stop_grace_period: input.stop_grace_period,
        init: input.init,
        expose: input.expose,
        labels: input.labels,
        depends_on: input.depends_on,
      }),
    );
  }

  return deployManifest(
    {
      manifest: manifestJson,
      sku: { kind: 'byName', size: input.size },
      storage: input.storage,
      customDomain: input.customDomain,
      serviceName: input.serviceName,
      gasMultiplier: input.gasMultiplier,
      onLeaseCreated: input.onLeaseCreated,
      abortSignal: input.abortSignal,
      pollOptions: input.pollOptions,
    },
    { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn },
  );
}
