// One-shot live x402 settlement test. Polls the payer wallet's USDC balance on Base,
// then pays the live 402 -> provisions a real box -> verifies -> destroys it.
import { createPublicClient, http, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { readFileSync } from 'node:fs';

const API = 'https://api.agentmetal.dev';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HCLOUD = process.env.HCLOUD_TOKEN;
const pk = readFileSync('/tmp/am-test-wallet.key', 'utf8').trim();
const acct = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('payer:', acct.address);
console.log('[1] polling Base USDC balance (waiting for funding)...');
let bal = 0n;
for (let i = 0; i < 150; i++) {
  try {
    bal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] });
  } catch (e) { /* rpc hiccup */ }
  if (bal >= 350000n) { console.log(`  funded: ${Number(bal) / 1e6} USDC`); break; }
  if (i % 5 === 0) console.log(`  [${i * 20}s] balance ${Number(bal) / 1e6} USDC ...`);
  await sleep(20000);
}
if (bal < 350000n) { console.log('[TIMEOUT] wallet never funded (>= 0.35 USDC). Re-run when funded.'); process.exit(2); }

console.log('[2] paying the live 402 (x402 settle) + provisioning...');
const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(acct) }],
});
let server;
try {
  const res = await payFetch(`${API}/v1/servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'nano', days: 1 }),
  });
  const body = await res.json();
  console.log('  provision status:', res.status);
  console.log('  body:', JSON.stringify(body).slice(0, 400));
  if (res.status !== 201) { console.log('[FAIL] expected 201; payment/settle did not provision'); process.exit(1); }
  server = body;
  console.log(`  >>> SETTLED + PROVISIONED: ${server.id} -> ${server.ipv4}  ssh: ${server.ssh}`);
} catch (e) {
  console.log('[FAIL] payment threw:', (e.message || String(e)).slice(0, 300));
  process.exit(1);
}

console.log('[3] verify status via API...');
const st = await (await fetch(`${API}/v1/servers/${server.id}`)).json();
console.log('  status:', st.status, '| expires:', st.expires_at);

console.log('[4] cleanup: delete the real Hetzner box by IP...');
try {
  const list = await (await fetch('https://api.hetzner.cloud/v1/servers', { headers: { Authorization: `Bearer ${HCLOUD}` } })).json();
  const hz = (list.servers || []).find((s) => s.public_net?.ipv4?.ip === server.ipv4);
  if (hz) {
    await fetch(`https://api.hetzner.cloud/v1/servers/${hz.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${HCLOUD}` } });
    console.log(`  deleted hetzner server ${hz.id} (${server.ipv4})`);
  } else {
    console.log(`  (no hetzner server matched ${server.ipv4}; it will expire + be reaped in 1 day)`);
  }
} catch (e) { console.log('  cleanup error:', e.message); }

console.log('[SUCCESS] real x402 payment SETTLED -> provisioned -> verified -> destroyed. Full flow works live.');
