#!/usr/bin/env node
// Live-payment canary — proves the whole money path end-to-end against PROD on a schedule, so a
// money-path regression (402 → verify → provision → settle → teardown) surfaces within a day instead
// of via a customer complaint. Pays the internal pico plan ($0.01/day, X-Test-Token-gated), asserts
// 201, verifies status, then deletes the real Hetzner box. The DB row is a 1-day pico lease, so the
// reaper clears it automatically (and that path exercises the 404-idempotent delete too).
//
// Credentials come from deploy/.env (HCLOUD_TOKEN, TEST_PLAN_TOKEN) + deploy/test-wallet.key, matching
// the rest of the repo's headless scripts. Env vars override the file if set.
//
// Exit codes (for the systemd timer / any monitor):
//   0  OK — paid, provisioned (201), verified, box deleted.
//   1  FAILURE — the money path is broken (no 201, or payment threw). ALERT-WORTHY.
//   2  SKIPPED — test wallet underfunded or at quota; not a money-path failure. Refund/investigate.
//   3  DEGRADED — provisioned fine but teardown failed; box will reap at the 1-day lease. Watch cost.
import { createPublicClient, http, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { readFileSync } from 'node:fs';

const API = process.env.AGENTMETAL_API ?? 'https://api.agentmetal.dev';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PICO_ATOMIC = 10000n; // pico = $0.01/day
const MIN_BALANCE = 20000n; // need > 1 run of headroom before we attempt (else skip, don't fail)
const REFILL_WARN = 60000n; // warn to top up below ~6 runs of headroom
const MAX_ACTIVE = 2; // unregistered wallet cap; at/over → skip (reaper should be clearing prior runs)

// Repo root: `../../` from packages/mcp when run in-tree (local); CANARY_ROOT overrides it when the
// repo is bind-mounted into the canary container (see deploy/systemd/agentmetal-canary.service).
const root = process.env.CANARY_ROOT ? new URL(`file://${process.env.CANARY_ROOT.replace(/\/?$/, '/')}`) : new URL('../../', import.meta.url);
const envFile = (() => { try { return readFileSync(new URL('deploy/.env', root), 'utf8'); } catch { return ''; } })();
const val = (k) => process.env[k] ?? (envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();
const HCLOUD = val('HCLOUD_TOKEN');
const TEST_TOKEN = val('TEST_PLAN_TOKEN');
const pk = readFileSync(new URL('deploy/test-wallet.key', root), 'utf8').trim();

const acct = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: base, transport: http(process.env.X402_RPC_URL ?? 'https://mainnet.base.org') });
const log = (...a) => console.log('[canary]', ...a);
const usd = (atomic) => (Number(atomic) / 1e6).toFixed(4);
const die = (code, msg) => { log(msg); process.exit(code); };

if (!TEST_TOKEN) die(2, 'SKIP: no TEST_PLAN_TOKEN available — cannot exercise the pico plan.');
log(`payer ${acct.address} → ${API}`);

// [1] funding + quota preflight — a skip here is NOT a money-path failure.
let bal;
try {
  bal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] });
} catch (e) {
  die(2, `SKIP: could not read USDC balance (RPC): ${(e.message || e).toString().slice(0, 200)}`);
}
log(`balance ${usd(bal)} USDC`);
if (bal < MIN_BALANCE) die(2, `SKIP: balance ${usd(bal)} < ${usd(MIN_BALANCE)} USDC. Fund ${acct.address} on Base.`);

try {
  const j = await (await fetch(`${API}/v1/servers?wallet=${acct.address}`)).json();
  const active = (j.servers || []).filter((s) => ['provisioning', 'running', 'suspended', 'expired'].includes(s.status));
  if (active.length >= MAX_ACTIVE) {
    die(2, `SKIP: test wallet at quota (${active.length} active: ${active.map((s) => `${s.id}:${s.status}`).join(', ')}). The reaper should clear prior pico leases; investigate if this persists.`);
  }
  log(`active rows: ${active.length}/${MAX_ACTIVE} — clear to provision`);
} catch (e) {
  log(`warn: quota preflight failed (${(e.message || e).toString().slice(0, 120)}); proceeding`);
}

// [2] pay the live 402 (pico) and provision — the assertion under test.
const payFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(acct) }] });
const t0 = Date.now();
let server;
try {
  const res = await payFetch(`${API}/v1/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Test-Token': TEST_TOKEN },
    body: JSON.stringify({ plan: 'pico', days: 1, via: 'canary' }),
  });
  const body = await res.json();
  if (res.status !== 201) {
    die(1, `FAIL: expected 201, got ${res.status}. Money path broken. body=${JSON.stringify(body).slice(0, 400)}`);
  }
  server = body;
  log(`PROVISIONED in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${server.id} → ${server.ipv4}  (payment ${server.payment?.tx_hash ?? 'n/a'})`);
} catch (e) {
  die(1, `FAIL: payment/provision threw — money path broken: ${(e.message || e).toString().slice(0, 300)}`);
}

// [3] verify the API agrees it's running.
try {
  const st = await (await fetch(`${API}/v1/servers/${server.id}`)).json();
  log(`verify: status=${st.status} expires=${st.expires_at}`);
  if (st.status !== 'running' && st.status !== 'provisioning') log(`warn: unexpected status ${st.status}`);
} catch (e) {
  log(`warn: status verify failed (${(e.message || e).toString().slice(0, 120)})`);
}

// [4] teardown — delete the real Hetzner box now; the DB row reaps at the 1-day pico lease.
let cleanupOk = true;
try {
  const list = await (await fetch('https://api.hetzner.cloud/v1/servers?per_page=50', { headers: { Authorization: `Bearer ${HCLOUD}` } })).json();
  const hz = (list.servers || []).find((s) => s.public_net?.ipv4?.ip === server.ipv4);
  if (hz) {
    const del = await fetch(`https://api.hetzner.cloud/v1/servers/${hz.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${HCLOUD}` } });
    if (del.ok || del.status === 404) log(`teardown: deleted Hetzner box ${hz.id} (${server.ipv4})`);
    else { cleanupOk = false; log(`warn: Hetzner delete returned ${del.status}`); }
  } else {
    log(`teardown: no Hetzner box matched ${server.ipv4} (already gone; DB row reaps at lease end)`);
  }
} catch (e) {
  cleanupOk = false;
  log(`warn: teardown error (${(e.message || e).toString().slice(0, 200)}); box reaps at the 1-day lease`);
}

if (bal - PICO_ATOMIC < REFILL_WARN) log(`NOTE: low balance — ~${usd(bal - PICO_ATOMIC)} USDC left. Top up ${acct.address} on Base.`);

if (!cleanupOk) die(3, 'DEGRADED: money path OK (201) but teardown failed — box will reap at the 1-day lease; verify cost.');
die(0, 'OK: 402 → verify → provision → settle → teardown all live. Money path healthy.');
