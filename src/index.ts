#!/usr/bin/env node
/**
 * AgentMetal MCP server (stdio).
 *
 * Exposes the AgentMetal API as MCP tools so an agent can discover → pay → provision →
 * renew a server with no human signup. Paid tools (provision, extend) sign USDC payments
 * via x402 v2 using a wallet private key; the rest are plain HTTP.
 *
 * Env:
 *   AGENTMETAL_BASE_URL   API base (default https://api.agentmetal.dev)
 *   WALLET_PRIVATE_KEY    0x… EVM key used to pay 402s (omit → paid tools error clearly)
 *   AGENTMETAL_NETWORK    CAIP-2 network (default eip155:8453 — Base mainnet)
 *   AGENTMETAL_MAX_USDC   per-request spend cap in USDC (default 50)
 *   AGENTMETAL_API_KEY    am_live_… account key for destroy / account-scoped tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { wrapFetchWithPaymentFromConfig, type SelectPaymentRequirements } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { AgentMetalClient, type FetchLike } from './client.ts';

const env = process.env;
const baseUrl = env.AGENTMETAL_BASE_URL ?? 'https://api.agentmetal.dev';
const network = (env.AGENTMETAL_NETWORK ?? 'eip155:8453') as `${string}:${string}`;
const maxUsdc = Number(env.AGENTMETAL_MAX_USDC ?? '50');

/** Build a fetch that answers 402s by signing USDC, capped at AGENTMETAL_MAX_USDC. */
function buildPayFetch(): FetchLike {
  const pk = env.WALLET_PRIVATE_KEY;
  if (!pk) return globalThis.fetch as unknown as FetchLike;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const maxAtomic = BigInt(Math.round(maxUsdc * 1_000_000));
  const selectWithinCap: SelectPaymentRequirements = (_version, accepts) => {
    const affordable = accepts.find((a) => BigInt(a.amount) <= maxAtomic) ?? accepts[0];
    if (!affordable) throw new Error('the 402 offered no payment requirements');
    if (BigInt(affordable.amount) > maxAtomic) {
      throw new Error(`payment ${affordable.amount} atomic exceeds the ${maxUsdc} USDC cap (raise AGENTMETAL_MAX_USDC)`);
    }
    return affordable;
  };
  return wrapFetchWithPaymentFromConfig(globalThis.fetch, {
    schemes: [{ network, client: new ExactEvmScheme(account) }],
    paymentRequirementsSelector: selectWithinCap,
  }) as unknown as FetchLike;
}

/** The configured wallet's address, used as the default fleet to list. */
const walletAddress = env.WALLET_PRIVATE_KEY
  ? privateKeyToAccount(env.WALLET_PRIVATE_KEY as `0x${string}`).address
  : undefined;

const client = new AgentMetalClient({
  baseUrl,
  payFetch: buildPayFetch(),
  fetch: globalThis.fetch as unknown as FetchLike,
  ...(env.AGENTMETAL_API_KEY ? { apiKey: env.AGENTMETAL_API_KEY } : {}),
});

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
  isError: true,
});

const server = new McpServer({ name: 'agentmetal', version: '0.1.2' });

server.registerTool(
  'provision_server',
  {
    title: 'Provision a server',
    description:
      'Provision a brand-new Linux VPS and pay for it in a single call. SPENDS REAL USDC — ' +
      'the payment is signed on-chain via x402 (Base) up to this MCP server\'s per-call spend cap; ' +
      'it is a real charge, not a quote or a dry run. Returns the server id (srv_…), public IPv4, and ' +
      'an `ssh root@<ip>` target, usually reachable in under 60 seconds. Use when an agent needs its own ' +
      'compute to build, run, or host something with no human signup. Pass `ssh_key` to get inbound SSH; ' +
      'omit it and the box boots with no way to log in. The lease lasts `days` days, after which the ' +
      'server is automatically destroyed unless you extend_server first.',
    inputSchema: {
      plan: z.enum(['nano', 'small', 'medium']).describe('Server size / price tier: "nano" (smallest, cheapest), "small", or "medium". Choose the smallest that fits the workload.'),
      days: z.number().int().min(1).max(30).describe('Lease length in whole days (1–30). The server auto-destroys at expiry unless extended; you pay up front for the whole lease.'),
      ssh_key: z.string().optional().describe('Optional single-line OpenSSH public key (e.g. "ssh-ed25519 AAAA…") authorized for root SSH. Omit and the box has NO inbound SSH access.'),
      via: z.string().optional().describe('Optional attribution tag (e.g. the calling skill name). Analytics only; does not affect provisioning.'),
    },
  },
  async (args) => {
    try {
      const input: Parameters<AgentMetalClient['provision']>[0] = { plan: args.plan, days: args.days };
      if (args.ssh_key) input.sshKey = args.ssh_key;
      if (args.via) input.via = args.via;
      return ok(await client.provision(input));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'get_server',
  {
    title: 'Get server status',
    description:
      "Look up one server's live status (provisioning | running | suspended | expired | destroyed), " +
      'public IPv4, lease expiry (unix seconds), and bandwidth usage. Read-only — never charges money or ' +
      'changes the server. Use to confirm a box is up and reachable, or to see how long it has before auto-destroy.',
    inputSchema: { id: z.string().describe('Server id returned by provision_server, e.g. "srv_abc123".') },
  },
  async (args) => {
    try {
      return ok(await client.get(args.id));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'list_servers',
  {
    title: 'List your servers',
    description:
      'List every server (the fleet) for a payer wallet, or for the whole account when an account API key ' +
      'is configured. Read-only — never charges or changes anything. Defaults to the wallet configured on this ' +
      'MCP server; pass `wallet` to list a different payer. Use to enumerate active boxes before calling ' +
      'extend_server or destroy_server.',
    inputSchema: {
      wallet: z.string().optional().describe('Optional payer wallet address (0x…) whose servers to list. Defaults to this MCP server\'s configured wallet.'),
    },
  },
  async (args) => {
    try {
      const wallet = args.wallet ?? walletAddress;
      return ok(await client.list(wallet ? { wallet } : {}));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'extend_server',
  {
    title: 'Extend a server lease',
    description:
      'Extend an existing server\'s lease so it is not auto-destroyed at expiry. SPENDS REAL USDC — signed ' +
      'on-chain via x402 (Base) up to the per-call spend cap; a real charge. Adds `days` days to the current ' +
      'expiry and returns the new expiry (unix seconds). Use before a lease runs out to keep a box alive; ' +
      'check the current expiry first with get_server.',
    inputSchema: {
      id: z.string().describe('Server id to extend, e.g. "srv_abc123".'),
      days: z.number().int().min(1).max(30).describe('Whole days to add to the current lease (1–30).'),
    },
  },
  async (args) => {
    try {
      return ok(await client.extend(args.id, args.days));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'destroy_server',
  {
    title: 'Destroy a server',
    description:
      'Permanently destroy a server RIGHT NOW, before its lease expires. IRREVERSIBLE — the VM and all its ' +
      'data are deleted and remaining lease time is NOT refunded. Requires an account API key ' +
      '(AGENTMETAL_API_KEY); without one this returns an auth error. Use to free quota or stop holding an ' +
      'unneeded box. To let a box expire naturally instead, simply do not extend it.',
    inputSchema: { id: z.string().describe('Server id to destroy, e.g. "srv_abc123". This action cannot be undone.') },
  },
  async (args) => {
    try {
      return ok(await client.destroy(args.id));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'claim_account',
  {
    title: 'Claim an account (request code)',
    description:
      'Begin claiming an AgentMetal account by email. Sends a one-time 6-digit code to the address; redeem ' +
      'it with verify_claim to get an account API key. Side effect: sends one email. Does not charge. ' +
      'Accounts are OPTIONAL — they add fleet management under one key, monthly card billing, and higher ' +
      'quotas, but are not required to provision or pay. Call verify_claim next with the emailed code.',
    inputSchema: { email: z.string().email().describe('Email address that should receive the one-time 6-digit claim code.') },
  },
  async (args) => {
    try {
      return ok(await client.claim(args.email));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'verify_claim',
  {
    title: 'Verify an account claim',
    description:
      'Complete an account claim using the 6-digit code emailed by claim_account. Returns a long-lived ' +
      'account API key (am_live_…) — store it securely; it authorizes destroy_server and account-scoped ' +
      'calls. Optionally link a wallet so its existing servers attach to the account. The code expires ' +
      '10 minutes after claim_account and is invalidated after 5 wrong attempts (re-run claim_account to retry).',
    inputSchema: {
      email: z.string().email().describe('The same email address you passed to claim_account.'),
      code: z.string().describe('The 6-digit code from the claim email.'),
      wallet: z.string().optional().describe('Optional wallet address (0x…) to link to the account, attaching its existing servers.'),
    },
  },
  async (args) => {
    try {
      const input: Parameters<AgentMetalClient['verifyClaim']>[0] = { email: args.email, code: args.code };
      if (args.wallet) input.wallet = args.wallet;
      return ok(await client.verifyClaim(input));
    } catch (err) {
      return fail(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is the JSON-RPC channel.
  console.error(`agentmetal MCP server ready (api: ${baseUrl}, wallet: ${env.WALLET_PRIVATE_KEY ? 'on' : 'off'})`);
}

main().catch((err) => {
  console.error('[agentmetal-mcp] fatal', err);
  process.exit(1);
});
