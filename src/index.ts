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

const server = new McpServer({ name: 'agentmetal', version: '0.1.0' });

server.registerTool(
  'provision_server',
  {
    title: 'Provision a server',
    description: 'Provision a VPS, paying with USDC via x402. Returns the server id, IPv4, and SSH target. Sub-60s.',
    inputSchema: {
      plan: z.enum(['nano', 'small', 'medium']).describe('Server size'),
      days: z.number().int().min(1).max(30).describe('Lease length in days (1–30)'),
      ssh_key: z.string().optional().describe('SSH public key to authorize on the box'),
      via: z.string().optional().describe('Attribution tag, e.g. the calling skill name'),
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
    description: "Fetch a server's current status, IPv4, and expiry.",
    inputSchema: { id: z.string().describe('Server id, e.g. srv_…') },
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
    description: 'List the fleet for a wallet (defaults to this server\'s configured wallet) or, with an account key, the account\'s servers.',
    inputSchema: {
      wallet: z.string().optional().describe('Payer wallet to list; defaults to the configured wallet'),
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
    description: 'Extend a server lease by N days, paying with USDC via x402.',
    inputSchema: {
      id: z.string().describe('Server id'),
      days: z.number().int().min(1).max(30).describe('Days to add (1–30)'),
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
    description: 'Destroy a server now. Requires an account API key (AGENTMETAL_API_KEY).',
    inputSchema: { id: z.string().describe('Server id') },
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
    description: 'Start claiming an account: AgentMetal emails a one-time code to verify with verify_claim.',
    inputSchema: { email: z.string().email().describe('Email to receive the code') },
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
    description: 'Complete a claim with the emailed code; returns an account API key. Optionally link a wallet.',
    inputSchema: {
      email: z.string().email(),
      code: z.string().describe('The 6-digit code from the email'),
      wallet: z.string().optional().describe('Wallet address to link to the account'),
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
