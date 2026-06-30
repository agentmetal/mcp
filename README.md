# @agentmetal/mcp

MCP server that exposes [AgentMetal](https://agentmetal.dev) as tools, so an agent can
**discover → pay → provision → SSH in → run commands → manage → renew** its own Linux
server (VPS / cloud instance) with no human signup. Paid tools sign USDC payments over
[x402 v2](https://x402.org) (or pay by card); the rest are plain HTTP.

[![agentmetal/mcp MCP server](https://glama.ai/mcp/servers/agentmetal/mcp/badges/score.svg)](https://glama.ai/mcp/servers/agentmetal/mcp)
[![CI](https://github.com/agentmetal/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/agentmetal/mcp/actions/workflows/ci.yml)
[![smithery badge](https://smithery.ai/badge/luisalfonsocosioizcapa/agentmetal)](https://smithery.ai/servers/luisalfonsocosioizcapa/agentmetal)

## Tools

13 tools. Paid tools sign a USDC/x402 payment; account-gated tools need
`AGENTMETAL_API_KEY` (`am_live_…`) and ownership of the server.

| Tool | Pays? | Account key? | What it does |
|---|---|---|---|
| `get_catalog` | — | — | List plans, locations, and add-on pricing (bandwidth, storage). The free discovery hook. |
| `provision_server` | ✅ USDC | — | Provision a VPS (`plan`, `days`, optional `ssh_key`/`via`, `managed_key`) → id, IPv4, SSH. With `managed_key:true`, a server-side keypair is generated, authorized, and the private key returned **once** (stored only encrypted) to enable `exec_command`. |
| `get_server` | — | — | Status, IPv4, expiry, bandwidth, storage for a server id |
| `list_servers` | — | — | Fleet for a wallet/account |
| `extend_server` | ✅ USDC | — | Extend a lease by N days |
| `destroy_server` | — | ✅ | Destroy now |
| `reboot_server` | — | ✅ | Soft-reboot an owned server |
| `server_logs` | — | ✅ | Hypervisor-level diagnostics without logging in: status, recent provider actions, a VNC console URL, and live CPU/disk/net metrics (no text boot log exists provider-side) |
| `exec_command` | — | ✅ | Run a shell command as **root** over SSH → exit_code/stdout/stderr. Requires a server provisioned with `managed_key:true`. Bounded: 1–120 s timeout, 256 KB output cap. |
| `get_firewall` | — | — | Read a box's edge-firewall rules. Callable from the box itself (source-IP identity) or with an account key. |
| `manage_firewall` | — | — | Open/close inbound ports on a box's edge firewall (protocol/port/source_ips). From the box itself or with an account key; SSH-lockout guarded. |
| `claim_account` | — | — | Email a one-time claim code (via AWS SES) |
| `verify_claim` | — | — | Redeem the code for an account API key. Link a wallet by also passing `wallet` + `wallet_signature`. |

**Add-ons** (currently API endpoints, not yet separate MCP tools): extra **storage**
($0.01/GB/day, attached block volume) via `POST /v1/servers/{id}/storage` and extra
**bandwidth** ($2/TB beyond the 20 TB included) via `POST /v1/servers/{id}/bandwidth`.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `AGENTMETAL_BASE_URL` | `https://api.agentmetal.dev` | API base URL |
| `WALLET_PRIVATE_KEY` | — | `0x…` EVM key used to pay 402s. Omit and paid tools fail with a clear message. |
| `AGENTMETAL_NETWORK` | `eip155:8453` | CAIP-2 network (Base mainnet) |
| `AGENTMETAL_MAX_USDC` | `50` | Per-request spend cap, in USDC |
| `AGENTMETAL_API_KEY` | — | `am_live_…` account key, required for `destroy_server` / `reboot_server` / `server_logs` / `exec_command` |

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
