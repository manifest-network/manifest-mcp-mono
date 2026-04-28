import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cosmos } from '@manifest-network/manifestjs';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * End-to-end coverage for every group module subcommand routed through
 * cosmos_query / cosmos_tx (the high-level group MCP tools we already
 * cover are a different layer).
 *
 * The test creates a fresh group + policy owned by the test wallet and
 * walks through the full lifecycle:
 *   - create-group → group / policy queries
 *   - update-group-{members,metadata,admin}
 *   - create-group-policy → policy queries
 *   - update-group-policy-{metadata,decision-policy,admin}
 *   - submit-proposal → vote → tally → exec
 *   - submit-proposal → withdraw-proposal
 *   - leave-group
 *   - create-group-with-policy (separate, single-tx variant)
 *
 * Voting period starts at 10s on create-group-policy and is bumped to 12s
 * mid-test by update-group-policy-decision-policy. The votable proposal is
 * submitted *after* the bump, so vote / votes-by-proposal / tally queries
 * land while the proposal is still active (cosmos-sdk x/group prunes the
 * proposal — and its votes — once it transitions to ACCEPTED/REJECTED and
 * minExecutionPeriod has elapsed). After all in-period queries we sleep
 * past the voting period (~13s) and explicitly exec.
 */

const PROVIDER_ADDRESS = 'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Group lifecycle', () => {
  const client = new MCPTestClient();

  let testAddress: string;
  let groupId: string;
  let policyAddress: string;
  let votableProposalId: string;
  let withdrawableProposalId: string;

  beforeAll(async () => {
    await client.connect({ serverEntry: 'packages/node/dist/chain.js' });
    const acct = await client.callTool<{ address: string }>('get_account_info');
    testAddress = acct.address;
  });

  afterAll(async () => {
    await client.close();
  });

  // ==========================================================================
  // 1. create-group + initial queries
  // ==========================================================================
  it('tx: create-group establishes a fresh group owned by the test wallet', async () => {
    // Snapshot existing groups for this admin so we can identify the new one
    // (chain state persists across re-runs).
    const beforeRes = await client.callTool<{
      result: { groups: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'groups-by-admin',
      args: [testAddress, '--limit', '1000'],
    });
    const beforeIds = new Set(beforeRes.result.groups.map((g) => g.id));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'create-group',
      args: ['lifecycle-group', `${testAddress}:1`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { groups: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'groups-by-admin',
      args: [testAddress, '--limit', '1000'],
    });
    const newGroup = afterRes.result.groups.find((g) => !beforeIds.has(g.id));
    expect(newGroup).toBeDefined();
    groupId = newGroup!.id;
  });

  it('query: group-info returns the new group', async () => {
    const result = await client.callTool<{
      result: { info: { id: string; admin: string; metadata: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-info',
      args: [groupId],
    });
    expect(result.result.info.id).toBe(groupId);
    expect(result.result.info.admin).toBe(testAddress);
    expect(result.result.info.metadata).toBe('lifecycle-group');
  });

  it('query: groups paginated list contains the new group', async () => {
    const result = await client.callTool<{
      result: { groups: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'groups',
      args: ['--limit', '1000'],
    });
    expect(result.result.groups.find((g) => g.id === groupId)).toBeDefined();
  });

  it('query: group-members lists the test wallet as the only member', async () => {
    const result = await client.callTool<{
      result: { members: Array<{ member: { address: string; weight: string } }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-members',
      args: [groupId],
    });
    expect(result.result.members).toHaveLength(1);
    expect(result.result.members[0].member.address).toBe(testAddress);
    expect(result.result.members[0].member.weight).toBe('1');
  });

  it('query: groups-by-member finds the group for the test wallet', async () => {
    const result = await client.callTool<{
      result: { groups: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'groups-by-member',
      args: [testAddress, '--limit', '1000'],
    });
    expect(result.result.groups.find((g) => g.id === groupId)).toBeDefined();
  });

  // ==========================================================================
  // 2. update-group-* (admin txs)
  // ==========================================================================
  it('tx: update-group-members adds PROVIDER_ADDRESS as a member', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'update-group-members',
      args: [groupId, `${PROVIDER_ADDRESS}:1`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const members = await client.callTool<{
      result: { members: Array<{ member: { address: string } }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-members',
      args: [groupId],
    });
    const addrs = members.result.members.map((m) => m.member.address);
    expect(addrs).toContain(testAddress);
    expect(addrs).toContain(PROVIDER_ADDRESS);
  });

  it('tx: update-group-metadata changes the group metadata', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'update-group-metadata',
      args: [groupId, 'updated-metadata'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const info = await client.callTool<{
      result: { info: { metadata: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-info',
      args: [groupId],
    });
    expect(info.result.info.metadata).toBe('updated-metadata');
  });

  // ==========================================================================
  // 3. create-group-policy + policy queries
  // ==========================================================================
  it('tx: create-group-policy creates a threshold-1 policy on the group', async () => {
    const beforeRes = await client.callTool<{
      result: { groupPolicies: Array<{ address: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policies-by-group',
      args: [groupId],
    });
    const beforeAddrs = new Set(beforeRes.result.groupPolicies.map((p) => p.address));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'create-group-policy',
      // [group-id, metadata, policy-type, threshold-or-pct, voting-period-secs, min-exec-secs]
      args: [groupId, 'lifecycle-policy', 'threshold', '1', '10', '0'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { groupPolicies: Array<{ address: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policies-by-group',
      args: [groupId],
    });
    const newPolicy = afterRes.result.groupPolicies.find(
      (p) => !beforeAddrs.has(p.address),
    );
    expect(newPolicy).toBeDefined();
    policyAddress = newPolicy!.address;
  });

  it('query: group-policy-info returns the new policy', async () => {
    const result = await client.callTool<{
      result: { info: { address: string; admin: string; groupId: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policy-info',
      args: [policyAddress],
    });
    expect(result.result.info.address).toBe(policyAddress);
    expect(result.result.info.admin).toBe(testAddress);
    expect(result.result.info.groupId).toBe(groupId);
  });

  it('query: group-policies-by-admin lists the test wallet policies', async () => {
    const result = await client.callTool<{
      result: { groupPolicies: Array<{ address: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policies-by-admin',
      args: [testAddress, '--limit', '1000'],
    });
    expect(
      result.result.groupPolicies.find((p) => p.address === policyAddress),
    ).toBeDefined();
  });

  // ==========================================================================
  // 4. update-group-policy-* (admin txs on the policy)
  // ==========================================================================
  it('tx: update-group-policy-metadata changes the policy metadata', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'update-group-policy-metadata',
      args: [policyAddress, 'updated-policy-metadata'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const info = await client.callTool<{
      result: { info: { metadata: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policy-info',
      args: [policyAddress],
    });
    expect(info.result.info.metadata).toBe('updated-policy-metadata');
  });

  it('tx: update-group-policy-decision-policy bumps voting period to 12s', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'update-group-policy-decision-policy',
      // [policy-address, policy-type, threshold-or-pct, voting-period-secs, min-exec-secs]
      args: [policyAddress, 'threshold', '1', '12', '0'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // ==========================================================================
  // 5. submit-proposal → vote → tally → exec (full happy path)
  //
  // The proposal contains a MsgUpdateGroupPolicyMetadata that points back at
  // the policy address itself — a self-targeting message that needs the
  // policy to be its own admin. We transfer policy admin to the policy
  // before submitting.
  // ==========================================================================
  it('tx: update-group-policy-admin transfers admin to the policy itself', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'update-group-policy-admin',
      args: [policyAddress, policyAddress],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const info = await client.callTool<{
      result: { info: { admin: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policy-info',
      args: [policyAddress],
    });
    expect(info.result.info.admin).toBe(policyAddress);
  });

  it('tx: submit-proposal queues a self-update proposal', async () => {
    // Encode MsgUpdateGroupPolicyMetadata{admin: policy, address: policy, metadata: 'from-proposal'}
    // The submit-proposal handler expects messages as JSON with base64-encoded
    // protobuf bytes (see parseProposalMessages in transactions/group.ts).
    const { MsgUpdateGroupPolicyMetadata } = cosmos.group.v1;
    const inner = MsgUpdateGroupPolicyMetadata.encode({
      admin: policyAddress,
      groupPolicyAddress: policyAddress,
      metadata: 'from-proposal',
    }).finish();
    const messageJson = JSON.stringify({
      typeUrl: '/cosmos.group.v1.MsgUpdateGroupPolicyMetadata',
      value: Buffer.from(inner).toString('base64'),
    });

    const beforeRes = await client.callTool<{
      result: { proposals: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'proposals-by-group-policy',
      args: [policyAddress, '--limit', '1000'],
    });
    const beforeIds = new Set(beforeRes.result.proposals.map((p) => p.id));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'submit-proposal',
      args: [policyAddress, 'self-update', 'rotate metadata via proposal', messageJson],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { proposals: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'proposals-by-group-policy',
      args: [policyAddress, '--limit', '1000'],
    });
    const newProposal = afterRes.result.proposals.find((p) => !beforeIds.has(p.id));
    expect(newProposal).toBeDefined();
    votableProposalId = newProposal!.id;
  });

  it('query: proposal returns the submitted proposal', async () => {
    const result = await client.callTool<{
      result: { proposal: { id: string; status: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'proposal',
      args: [votableProposalId],
    });
    expect(result.result.proposal.id).toBe(votableProposalId);
  });

  it('tx: vote yes on the proposal', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'vote',
      args: [votableProposalId, 'yes'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  it('query: vote (single), votes-by-proposal, votes-by-voter', async () => {
    const single = await client.callTool<{
      result: { vote: { proposalId: string; voter: string; option: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'vote',
      args: [votableProposalId, testAddress],
    });
    expect(single.result.vote.proposalId).toBe(votableProposalId);
    expect(single.result.vote.voter).toBe(testAddress);

    const byProp = await client.callTool<{
      result: { votes: Array<{ voter: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'votes-by-proposal',
      args: [votableProposalId],
    });
    expect(byProp.result.votes.find((v) => v.voter === testAddress)).toBeDefined();

    const byVoter = await client.callTool<{
      result: { votes: Array<{ proposalId: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'votes-by-voter',
      args: [testAddress, '--limit', '1000'],
    });
    expect(
      byVoter.result.votes.find((v) => v.proposalId === votableProposalId),
    ).toBeDefined();
  });

  it('query: tally reflects the yes vote', async () => {
    const result = await client.callTool<{
      result: { tally: { yesCount: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'tally',
      args: [votableProposalId],
    });
    expect(BigInt(result.result.tally.yesCount)).toBeGreaterThanOrEqual(1n);
  });

  it('tx: exec the proposal after voting period closes', async () => {
    // Voting period was bumped to 12s above; wait it out before exec.
    await sleep(13_000);

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'exec',
      args: [votableProposalId],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    // Verify the embedded MsgUpdateGroupPolicyMetadata actually ran.
    const info = await client.callTool<{
      result: { info: { metadata: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policy-info',
      args: [policyAddress],
    });
    expect(info.result.info.metadata).toBe('from-proposal');
  });

  // ==========================================================================
  // 6. submit-proposal + withdraw-proposal (separate proposal)
  // ==========================================================================
  it('tx: submit + withdraw-proposal cancels a fresh proposal before voting ends', async () => {
    const { MsgUpdateGroupPolicyMetadata } = cosmos.group.v1;
    const inner = MsgUpdateGroupPolicyMetadata.encode({
      admin: policyAddress,
      groupPolicyAddress: policyAddress,
      metadata: 'never-applied',
    }).finish();
    const messageJson = JSON.stringify({
      typeUrl: '/cosmos.group.v1.MsgUpdateGroupPolicyMetadata',
      value: Buffer.from(inner).toString('base64'),
    });

    const beforeRes = await client.callTool<{
      result: { proposals: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'proposals-by-group-policy',
      args: [policyAddress, '--limit', '1000'],
    });
    const beforeIds = new Set(beforeRes.result.proposals.map((p) => p.id));

    const submit = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'submit-proposal',
      args: [policyAddress, 'will-withdraw', 'to be withdrawn', messageJson],
      wait_for_confirmation: true,
    });
    expect(submit.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { proposals: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'proposals-by-group-policy',
      args: [policyAddress, '--limit', '1000'],
    });
    const newProposal = afterRes.result.proposals.find((p) => !beforeIds.has(p.id));
    expect(newProposal).toBeDefined();
    withdrawableProposalId = newProposal!.id;

    const withdraw = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'withdraw-proposal',
      args: [withdrawableProposalId],
      wait_for_confirmation: true,
    });
    expect(withdraw.code).toBe(0);

    // cosmos-sdk x/group keeps withdrawn proposals in storage with status
    // PROPOSAL_STATUS_WITHDRAWN (= 5) but stops accepting them via direct
    // `proposal [id]` queries. Verify via proposals-by-group-policy that
    // the withdrawn proposal is still listed but with WITHDRAWN status.
    const remaining = await client.callTool<{
      result: { proposals: Array<{ id: string; status: number | string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'proposals-by-group-policy',
      args: [policyAddress, '--limit', '1000'],
    });
    const withdrawn = remaining.result.proposals.find(
      (p) => p.id === withdrawableProposalId,
    );
    expect(withdrawn).toBeDefined();
    // ProposalStatus.PROPOSAL_STATUS_WITHDRAWN = 5
    expect(withdrawn!.status).toBe(5);
  });

  // ==========================================================================
  // 7. leave-group + update-group-admin (final cleanup)
  // ==========================================================================
  it('tx: leave-group removes the test wallet from the membership', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'leave-group',
      args: [groupId],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const members = await client.callTool<{
      result: { members: Array<{ member: { address: string } }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-members',
      args: [groupId],
    });
    expect(
      members.result.members.find((m) => m.member.address === testAddress),
    ).toBeUndefined();
  });

  it('tx: update-group-admin transfers group admin to PROVIDER_ADDRESS', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'update-group-admin',
      args: [groupId, PROVIDER_ADDRESS],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const info = await client.callTool<{
      result: { info: { admin: string } };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-info',
      args: [groupId],
    });
    expect(info.result.info.admin).toBe(PROVIDER_ADDRESS);
  });

  // ==========================================================================
  // 8. create-group-with-policy (single-tx variant)
  // ==========================================================================
  it('tx: create-group-with-policy creates both in one tx', async () => {
    const beforeGroups = await client.callTool<{
      result: { groups: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'groups-by-admin',
      args: [testAddress, '--limit', '1000'],
    });
    const beforeIds = new Set(beforeGroups.result.groups.map((g) => g.id));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'group',
      subcommand: 'create-group-with-policy',
      // [group-metadata, policy-metadata, type, threshold, voting, min-exec, address:weight]
      args: [
        'gp-group',
        'gp-policy',
        'threshold',
        '1',
        '2',
        '0',
        `${testAddress}:1`,
      ],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterGroups = await client.callTool<{
      result: { groups: Array<{ id: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'groups-by-admin',
      args: [testAddress, '--limit', '1000'],
    });
    const newGroup = afterGroups.result.groups.find((g) => !beforeIds.has(g.id));
    expect(newGroup).toBeDefined();

    // Verify the policy was attached to the new group.
    const policies = await client.callTool<{
      result: { groupPolicies: Array<{ address: string }> };
    }>('cosmos_query', {
      module: 'group',
      subcommand: 'group-policies-by-group',
      args: [newGroup!.id],
    });
    expect(policies.result.groupPolicies.length).toBeGreaterThan(0);
  });
});
