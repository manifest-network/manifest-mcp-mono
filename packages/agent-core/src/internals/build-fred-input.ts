/**
 * Discriminated-union narrowing builders: typed `DeploySpec` → fred's
 * `BuildManifestPreviewInput` and `DeployAppInput`. ENG-185 sub-PR A, item 2.
 *
 * Replaces the prior inline builders in `deploy-app.ts` (PR-3 commit B) that
 * used `as unknown as <fred-input>` casts and silently truncated
 * `SingleServiceSpec.port` arrays to `port[0]`.
 *
 * Bugs this file kills:
 *
 *   (a) Stack `ServiceDef.ports: number[]` (`types.ts:164`) is converted
 *       to fred's canonical port-map shape `Record<string, Record<string,
 *       never>>` (e.g. `{'80/tcp': {}}`). The prior inline cast passed
 *       the raw array straight through, so `buildManifestPreview` and
 *       fred's deploy-time builder saw different shapes — the meta-hash
 *       recorded on-chain drifted from the manifest actually uploaded.
 *
 *   (b) Single-service `SingleServiceSpec.port: number | number[]`
 *       (`types.ts:172`) — fred's image-mode input is `port: number`
 *       only. The prior inline builders did `port[0]`, silently dropping
 *       every other element. We now reject multi-element arrays with
 *       `ManifestMCPError(INVALID_CONFIG)` (strategy (a) per the task
 *       brief) and point the caller at `StackSpec` for natively
 *       multi-port deployments.
 *
 * No `as unknown as` casts. Discriminated narrowing uses the shared
 * `isStackSpec` predicate from `spec-normalize.ts`.
 */

import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type {
  BuildManifestPreviewInput,
  DeployAppInput as FredDeployAppInput,
} from '@manifest-network/manifest-mcp-fred';
import type { DeploySpec, ServiceDef, StackSpec } from '../types.js';
import { isStackSpec } from './spec-normalize.js';

/**
 * Fred's canonical service port-map shape (`{<port>/<protocol>: {}}`).
 * Mirrors `ServiceConfig.ports` and `ManifestPreviewServiceInput.ports`
 * in `packages/fred/src/tools/deployApp.ts` /
 * `packages/fred/src/tools/buildManifestPreview.ts`. The empty `{}`
 * value is required by fred's validator (see
 * `packages/fred/src/manifest.ts`).
 */
type FredPortMap = Record<string, Record<string, never>>;

/**
 * Internal shape used to build both preview and deploy service entries.
 * Assignable to both `ManifestPreviewServiceInput` (readonly fields) and
 * fred's `ServiceConfig` (mutable fields) — mutable arrays widen to
 * readonly arrays at the assignment site.
 */
interface ConvertedService {
  image: string;
  ports?: FredPortMap;
  env?: Record<string, string>;
  args?: string[];
  command?: string[];
}

/**
 * Convert a `ServiceDef.ports: number[]` to fred's canonical port-map
 * shape. Protocol defaults to `tcp` (the only protocol exposed via the
 * agent-core surface today; UDP is deferred until a caller needs it).
 */
function toPortMap(ports: readonly number[]): FredPortMap {
  const map: FredPortMap = {};
  for (const port of ports) {
    map[`${port}/tcp`] = {};
  }
  return map;
}

/**
 * Map a single `ServiceDef` (agent-core spec shape) → fred's
 * `ServiceConfig` shape. Omits optional fields when absent so callers
 * can compare emitted objects with `'foo' in out` checks (rather than
 * `out.foo === undefined`, which a `key: undefined` spread would defeat).
 */
function convertServiceDef(svc: ServiceDef): ConvertedService {
  const out: ConvertedService = { image: svc.image };
  if (svc.ports !== undefined && svc.ports.length > 0) {
    out.ports = toPortMap(svc.ports);
  }
  if (svc.env !== undefined) out.env = svc.env;
  if (svc.args !== undefined) out.args = [...svc.args];
  if (svc.command !== undefined) out.command = [...svc.command];
  return out;
}

function convertStackServices(
  spec: StackSpec,
): Record<string, ConvertedService> {
  const out: Record<string, ConvertedService> = {};
  for (const [name, svc] of Object.entries(spec.services)) {
    out[name] = convertServiceDef(svc);
  }
  return out;
}

/**
 * Narrow `SingleServiceSpec.port: number | number[] | undefined` to
 * fred's single-service `port: number | undefined`.
 *
 *   - `undefined`     → `undefined`
 *   - `80`            → `80`
 *   - `[80]`          → `80` (single-element array convenience)
 *   - `[80, 443, …]`  → `ManifestMCPError(INVALID_CONFIG)`
 *
 * Strategy (a) per the ENG-185 sub-PR A brief: rejecting multi-element
 * arrays at the builder boundary kills the prior silent `port[0]`
 * truncation. The error message points the caller at the `StackSpec`
 * escape hatch where multi-port routing is natively expressible.
 */
function narrowSingleServicePort(
  port: number | number[] | undefined,
): number | undefined {
  if (port === undefined) return undefined;
  if (typeof port === 'number') return port;
  if (Array.isArray(port)) {
    if (port.length === 0) return undefined;
    if (port.length === 1) return port[0];
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'SingleServiceSpec.port: multi-port single-service is not supported — use a StackSpec with explicit `services.<name>.ports` to expose multiple ports.',
    );
  }
  // Unreachable under the typed contract; defensive for `as unknown as`
  // callers that bypass the compile-time guard.
  return undefined;
}

/**
 * Build fred's `BuildManifestPreviewInput` from a typed `DeploySpec`.
 *
 * Stack arm: each `ServiceDef.ports: number[]` is converted to
 * `{<port>/tcp: {}}`. Services without `ports` (or with empty `[]`)
 * omit the `ports` key in the output.
 *
 * Single-service arm: `port: number` and `port: [80]` both produce
 * `port: 80`. Multi-element arrays throw INVALID_CONFIG.
 *
 * Deploy-only fields (`customDomain`, `serviceName`) are deliberately
 * NOT forwarded — the preview path computes only the manifest meta-hash;
 * domain claims happen later in the deploy path.
 *
 * The `size` parameter is accepted for signature parity with
 * `buildFredDeployInput` but is NOT included in the returned object:
 * fred's `BuildManifestPreviewInput` type has no `size` field and
 * `buildManifestPreview` derives no behavior from it. The prior inline
 * builder emitted `size` via an `as unknown as` cast that hid the
 * type-contract violation; this version drops it cleanly.
 */
export function buildManifestPreviewInput(
  spec: DeploySpec,
  // Reserved for signature parity with buildFredDeployInput; not consumed.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _size: string,
): BuildManifestPreviewInput {
  if (isStackSpec(spec)) {
    return { services: convertStackServices(spec) };
  }
  const port = narrowSingleServicePort(spec.port);
  return {
    image: spec.image,
    ...(port !== undefined ? { port } : {}),
    ...(spec.env !== undefined ? { env: spec.env } : {}),
  };
}

/**
 * Build fred's `DeployAppInput` from a typed `DeploySpec`.
 *
 * Same port-shape conversion as `buildManifestPreviewInput` (so the
 * meta-hash recorded on-chain matches the manifest actually uploaded).
 * Additionally threads `customDomain` (both shapes) and `serviceName`
 * (stack only — single-service leases have no service-name to address).
 *
 * @param pin Optional pre-resolved SKU pin (ENG-258). When supplied, spreads
 *   `skuUuid` and `providerUuid` into the output so fred's `deployApp` skips
 *   the name-based lookup (uses the `resolved` selector path). Existing
 *   2-arg callers are unaffected — the parameter is optional.
 */
export function buildFredDeployInput(
  spec: DeploySpec,
  size: string,
  pin?: { skuUuid: string; providerUuid: string },
): FredDeployAppInput {
  if (isStackSpec(spec)) {
    const out: FredDeployAppInput = {
      size,
      services: convertStackServices(spec),
      ...(pin ? { skuUuid: pin.skuUuid, providerUuid: pin.providerUuid } : {}),
    };
    if (typeof spec.customDomain === 'string' && spec.customDomain.length > 0) {
      out.customDomain = spec.customDomain;
      if (typeof spec.serviceName === 'string' && spec.serviceName.length > 0) {
        out.serviceName = spec.serviceName;
      }
    }
    return out;
  }
  const port = narrowSingleServicePort(spec.port);
  const out: FredDeployAppInput = {
    size,
    image: spec.image,
    ...(pin ? { skuUuid: pin.skuUuid, providerUuid: pin.providerUuid } : {}),
  };
  if (port !== undefined) out.port = port;
  if (spec.env !== undefined) out.env = spec.env;
  if (typeof spec.customDomain === 'string' && spec.customDomain.length > 0) {
    out.customDomain = spec.customDomain;
  }
  return out;
}
