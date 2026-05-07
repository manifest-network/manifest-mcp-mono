import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(mcpServer: McpServer): void {
  // -- deploy-containerized-app --
  mcpServer.registerPrompt(
    'deploy-containerized-app',
    {
      title: 'Deploy a containerized app to Manifest',
      description:
        'Walks through the full deploy lifecycle for a single containerized app: pre-flight check, manifest preview, deploy_app, and wait_for_app_ready. Emits a user-facing plan that asks for confirmation before broadcasting any transaction.',
      argsSchema: {
        image: z
          .string()
          .describe('Public Docker image to deploy (e.g. nginx:1.25)'),
        port: z
          .string()
          .optional()
          .describe(
            'TCP port the container exposes, as a string-encoded integer (e.g. "80"). MCP prompt arguments are always strings on the wire — the agent must parse this to a number before passing it to build_manifest_preview or deploy_app, whose port fields are typed as integers (1-65535). Required for single-service deployments.',
          ),
        size: z
          .string()
          .optional()
          .describe(
            'SKU tier name (e.g. "docker-micro"). Use browse_catalog or check_deployment_readiness to enumerate available sizes.',
          ),
      },
    },
    ({ image, port, size }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Deploy this containerized app to the Manifest network end-to-end. Use ONLY the manifest-mcp-fred tools listed below; never broadcast a transaction without explicit confirmation from the user.`,
              ``,
              `Inputs:`,
              `- image: ${image}`,
              `- port: ${port ?? '(unspecified — ask the user)'}`,
              `- size: ${size ?? '(unspecified — call browse_catalog to enumerate sizes and ask the user)'}`,
              ``,
              `Workflow:`,
              `1. Pre-flight: call \`check_deployment_readiness\` with { size, image }. If \`ready: false\`, surface the \`missing_steps\` list to the user and stop.`,
              `2. Build a manifest preview: call \`build_manifest_preview\` with \`image\` and \`port\` parsed as an integer (the prompt arg is a string; the tool's port schema is z.number().int().min(1).max(65535)). Show the user the resulting \`manifest_json\`, \`format\`, and \`meta_hash_hex\`. If \`validation.valid: false\`, surface every \`validation.errors\` entry verbatim and stop.`,
              `3. Print a deployment plan: image, manifest summary, SKU, provider (from \`check_deployment_readiness.sku\`), and the meta_hash. Wait for an explicit "yes" before continuing.`,
              `4. Call \`deploy_app\` (this broadcasts a chain TX and incurs fees). Pass any progressToken the host provides so the user sees provisioning progress.`,
              `5. Call \`wait_for_app_ready\` with the returned \`lease_uuid\`. On success, print the lease UUID, provider URL, and any \`status.endpoints\`. On failure, surface diagnostics and offer \`close_lease\` to reclaim the orphaned lease.`,
              ``,
              `Never skip the confirmation step in (3). If anything in (1) or (2) fails, do NOT proceed to (4).`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  // -- diagnose-failing-app --
  mcpServer.registerPrompt(
    'diagnose-failing-app',
    {
      title: 'Diagnose a failing or stuck deployed app',
      description:
        'Bundles app_status, app_diagnostics, and get_logs into a structured triage flow for a misbehaving lease.',
      argsSchema: {
        lease_uuid: z
          .string()
          .describe('Lease UUID of the app to diagnose (uuid format)'),
      },
    },
    ({ lease_uuid }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Diagnose lease ${lease_uuid} on Manifest. Surface a short triage report — do not propose fixes until the data is collected.`,
              ``,
              `1. \`app_status({ lease_uuid })\` — record the chainState and (if present) fredStatus.`,
              `2. \`app_diagnostics({ lease_uuid })\` — record provision_status, fail_count, and last_error.`,
              `3. \`get_logs({ lease_uuid, tail: 200 })\` — capture the most recent logs.`,
              ``,
              `Then summarize:`,
              `- Lease state on chain.`,
              `- Provider state (provision_status / phase / fail_count / last_error).`,
              `- Most relevant log lines (last error or repeated failures).`,
              `- One concrete next step (e.g. "image pull is failing — try a public registry", "container is restarting — inspect crash trace", "lease is closed — open a new deployment").`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  // -- shutdown-all-leases --
  mcpServer.registerPrompt(
    'shutdown-all-leases',
    {
      title: "Close all of the caller's active leases",
      description:
        "Lists the caller's active and pending leases and walks through closing each one. Always confirms with the user before broadcasting close_lease transactions.",
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Shut down every active or pending lease for the current wallet. Each \`close_lease\` is a chain transaction with fees, and is destructive — never call it without an explicit "yes" from the user.`,
              ``,
              `1. Read \`manifest://leases/active\` to list current leases. If the list is empty, report that and stop.`,
              `2. Print a numbered table: { uuid, state, provider_uuid, created_at }. Ask the user "close all (N), some, or none?".`,
              `3. For each UUID the user approves, call \`close_lease({ lease_uuid })\`.`,
              `4. After each close, print \`{ lease_uuid, status }\` so the user can confirm progress.`,
              `5. End with a summary: closed count, skipped count, any errors.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
