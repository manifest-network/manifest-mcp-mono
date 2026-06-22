import type { AppDeploySpec, ServiceConfig } from '../types.js';
import { isStackSpec, normalizeServices } from './spec-normalize.js';

/**
 * Render the structural portion of the intent-recap block shown to the user
 * before any chain round-trips in the deploy-app orchestrator.
 *
 * The 4 deterministic items the recap covers:
 *
 *   1. Deployment surface (service count + per-service `name — image`)
 *   2. Connectivity (per-port ingress posture)
 *   3. Redacted sensitive-key inventory (env / label keys only; never values)
 *   4. Custom-domain + dual-tx clarifier + mainnet warning (when applicable)
 *
 * The 2 LLM-judgment items ("what you provided vs auto-detected", "heads-up:
 * obvious gaps") stay in prose — the orchestrator appends them between the
 * deterministic block and the `AskUserQuestion` prompt.
 *
 * **Sensitive-value posture:** env values and label values are NEVER
 * surfaced; only keys appear. Mirrors `summarizeSpec`'s contract. FQDNs are
 * not secrets so `customDomain` is surfaced verbatim.
 *
 * **Port-shape handling:** two runtime shapes for ports:
 *   - Single-service: `port: number` → renders one ingress=true entry.
 *   - Stack service: `ServiceConfig.ports: Record<portKey, {}>` (canonical
 *     map, e.g. `{ '80/tcp': {} }`) → one entry per port-key (ingress
 *     default false). The recap renders the map KEY string (`'80/tcp'`),
 *     not a bare number.
 *
 * `extractPorts` also handles the historical `number[]` Record-or-array
 * shapes at runtime (matching `summarizeSpec`'s defensive widening) so
 * callers passing unknown-typed input from JSON.parse don't silently drop
 * ports.
 */

/** Render output is a multi-paragraph plain-text block, ready to print verbatim. */
export interface RenderIntentRecapInput {
  /** The structured deploy spec (canonical `AppDeploySpec` shape). */
  spec: AppDeploySpec;
  /** Active chain — drives the mainnet permanence warning. */
  activeChain: 'testnet' | 'mainnet';
}

interface NormalizedService {
  /** `null` for legacy single-service; the services-map key for stack leases. */
  name: string | null;
  /** Image string. Falls back to `(unknown image)` when missing. */
  image: string;
  /** Per-port ingress posture, in declaration order. */
  ports: { port: string; ingress: boolean }[];
  /** Sorted env keys (values redacted). */
  envKeys: string[];
  /** Sorted label keys (values redacted). */
  labelKeys: string[];
}

export function renderIntentRecap(input: RenderIntentRecapInput): string {
  if (input.activeChain !== 'testnet' && input.activeChain !== 'mainnet') {
    throw new TypeError(
      `renderIntentRecap: activeChain must be "testnet" or "mainnet"; got "${String(input.activeChain)}"`,
    );
  }

  const services = projectServices(input.spec);

  const blocks: string[] = [
    renderServiceList(services, input.activeChain),
    renderConnectivity(services),
    renderRedactedInventory(services),
  ];
  const domainBlock = renderCustomDomain(input.spec, input.activeChain);
  if (domainBlock !== null) {
    blocks.push(domainBlock);
  }

  return blocks.join('\n\n');
}

function projectServices(spec: AppDeploySpec): NormalizedService[] {
  return normalizeServices(spec).map(({ name, raw }): NormalizedService => {
    const rawRecord = raw as unknown as Record<string, unknown>;
    const image =
      typeof rawRecord.image === 'string' && rawRecord.image.length > 0
        ? rawRecord.image
        : '(unknown image)';
    const ports =
      name === null
        ? extractPortsLegacy((raw as AppDeploySpec).port)
        : extractPorts((raw as ServiceConfig).ports);
    return {
      name,
      image,
      ports,
      envKeys: extractKeys(rawRecord.env),
      labelKeys: extractKeys(rawRecord.labels),
    };
  });
}

/**
 * Services-map shape: `{ "80/tcp": { ingress?: boolean }, "9090": { ... } }`
 * (`ServiceConfig.ports` is a `Record<string, …>` port map). Ingress flag may
 * be absent — default `false` matches Fred's cluster-private default. Also
 * tolerates a legacy `number[]` shape defensively by treating each entry as
 * ingress=false (services-map default).
 */
function extractPorts(ports: unknown): { port: string; ingress: boolean }[] {
  if (Array.isArray(ports)) {
    return ports
      .filter((p): p is number => typeof p === 'number')
      .map((p) => ({ port: String(p), ingress: false }));
  }
  if (ports !== null && typeof ports === 'object') {
    return Object.entries(ports as Record<string, unknown>).map(
      ([port, cfg]) => ({
        port,
        ingress: !!(
          cfg !== null &&
          typeof cfg === 'object' &&
          (cfg as { ingress?: unknown }).ingress
        ),
      }),
    );
  }
  return [];
}

/**
 * Legacy single-service shape: bare `port: number`. Fred treats this as
 * ingress=true by default — that's the whole point of the simplified
 * shape.
 *
 * Also handles the `number[]` form (the frozen-contract array form):
 * returns one `{ port, ingress: true }` entry per array element, each
 * with `ingress: true` matching the single-service convention. Returns
 * `[]` for any other value (undefined, non-number scalar, non-array
 * object).
 *
 * M2 fix: prior JSDoc incorrectly stated "Returns `[]` for any other
 * value (including `number[]`...)" — empirically wrong per the
 * `Array.isArray(port)` branch below.
 */
function extractPortsLegacy(
  port: number | number[] | undefined,
): { port: string; ingress: boolean }[] {
  if (typeof port === 'number') {
    return [{ port: String(port), ingress: true }];
  }
  if (Array.isArray(port)) {
    return port
      .filter((p): p is number => typeof p === 'number')
      .map((p) => ({ port: String(p), ingress: true }));
  }
  return [];
}

function extractKeys(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj as Record<string, unknown>).sort();
}

function renderServiceList(
  services: NormalizedService[],
  activeChain: 'testnet' | 'mainnet',
): string {
  const count = services.length;
  const noun = count === 1 ? 'service' : 'services';
  const lines = [`Deploying ${count} ${noun} on ${activeChain}:`];
  for (const svc of services) {
    const prefix = svc.name === null ? '' : `${svc.name} — `;
    lines.push(`  - ${prefix}${svc.image}`);
  }
  return lines.join('\n');
}

function renderConnectivity(services: NormalizedService[]): string {
  const lines = ['Connectivity:'];
  let total = 0;
  for (const svc of services) {
    if (svc.ports.length === 0) continue;
    for (const p of svc.ports) {
      total += 1;
      const prefix =
        svc.name === null ? `port ${p.port}` : `${svc.name} port ${p.port}`;
      const reach = p.ingress
        ? "publicly reachable via the provider's HTTPS subdomain"
        : 'internal only (cluster-private)';
      lines.push(`  - ${prefix}: ${reach}`);
    }
  }
  if (total === 0) {
    lines.push(
      '  (no ports declared — the deployment will not expose any network surface)',
    );
  }
  return lines.join('\n');
}

function renderRedactedInventory(services: NormalizedService[]): string {
  // Always render the section header even if everything is empty — the user
  // should know we'd have shown values if there were any. This is also
  // documentation of the redaction discipline.
  const lines = [
    'Sensitive values are redacted in this recap (keys only, never values):',
  ];
  let anything = false;
  for (const svc of services) {
    const prefix = svc.name === null ? 'this service' : svc.name;
    const parts: string[] = [];
    if (svc.envKeys.length > 0) {
      anything = true;
      parts.push(`env keys [${svc.envKeys.join(', ')}]`);
    }
    if (svc.labelKeys.length > 0) {
      anything = true;
      parts.push(`label keys [${svc.labelKeys.join(', ')}]`);
    }
    if (parts.length === 0) {
      lines.push(`  - ${prefix}: no env or labels supplied`);
    } else {
      lines.push(`  - ${prefix}: ${parts.join('; ')}`);
    }
  }
  if (!anything) {
    lines.push(
      '  - (no env or labels supplied across any service — nothing to redact)',
    );
  }
  return lines.join('\n');
}

function renderCustomDomain(
  spec: AppDeploySpec,
  activeChain: 'testnet' | 'mainnet',
): string | null {
  const customDomain = spec.customDomain;
  if (typeof customDomain !== 'string' || customDomain.length === 0) {
    return null;
  }
  // `serviceName` only disambiguates a stack service; a single-service
  // spec's single service implicitly receives the domain.
  const serviceName = isStackSpec(spec) ? spec.serviceName : undefined;
  const target =
    typeof serviceName === 'string' && serviceName.length > 0
      ? `service ${serviceName}`
      : 'single-service lease';
  const lines = [`Custom domain: ${customDomain} → ${target}`];
  lines.push('');
  lines.push(
    'Note: when a custom domain is set, deploy_app broadcasts TWO billing\n' +
      'transactions atomically: create-lease AND set-item-custom-domain. The\n' +
      'single permission prompt that fires later covers BOTH; this textual\n' +
      'recap is your per-tx review.',
  );
  if (activeChain === 'mainnet') {
    lines.push('');
    lines.push(
      `Mainnet warning: this transaction permanently associates ${customDomain}\n` +
        'with this lease on-chain until you --clear it via\n' +
        '/manifest-agent:manage-domain or close the lease. FQDN squatting is\n' +
        'irreversible.',
    );
  }
  return lines.join('\n');
}
