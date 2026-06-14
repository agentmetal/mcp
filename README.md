# @agentmetal/mcp

MCP server that exposes [AgentMetal](https://agentmetal.dev) as tools, so an agent can
**discover → pay → provision → renew** a server with no human signup. Paid tools sign
USDC payments over [x402 v2](https://x402.org); the rest are plain HTTP.

## Tools

| Tool | Pays? | What it does |
|---|---|---|
| `provision_server` | ✅ USDC | Provision a VPS (`plan`, `days`, optional `ssh_key`/`via`) → id, IPv4, SSH |
| `get_server` | — | Status, IPv4, expiry for a server id |
| `extend_server` | ✅ USDC | Extend a lease by N days |
| `destroy_server` | — | Destroy now (needs `AGENTMETAL_API_KEY`) |
| `claim_account` | — | Email a one-time claim code |
| `verify_claim` | — | Redeem the code for an account API key |

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `AGENTMETAL_BASE_URL` | `https://api.agentmetal.dev` | API base URL |
| `WALLET_PRIVATE_KEY` | — | `0x…` EVM key used to pay 402s. Omit and paid tools fail with a clear message. |
| `AGENTMETAL_NETWORK` | `eip155:8453` | CAIP-2 network (Base mainnet) |
| `AGENTMETAL_MAX_USDC` | `50` | Per-request spend cap, in USDC |
| `AGENTMETAL_API_KEY` | — | `am_live_…` account key for destroy / account routes |

## Use with Claude Code

```jsonc
// .mcp.json (or claude mcp add)
{
  "mcpServers": {
    "agentmetal": {
      "command": "node",
      "args": ["packages/mcp/src/index.ts"],
      "env": {
        "WALLET_PRIVATE_KEY": "0x…",
        "AGENTMETAL_MAX_USDC": "50"
      }
    }
  }
}
```

The wallet must hold USDC on Base. The spend cap (`AGENTMETAL_MAX_USDC`) bounds what any
single tool call can pay; a 402 above the cap is refused before signing.

> **Status:** client + server are unit-tested and the stdio handshake is verified.
> Live USDC settlement needs a funded wallet + an x402 facilitator that supports the
> `exact` / `eip155:8453` kind.
