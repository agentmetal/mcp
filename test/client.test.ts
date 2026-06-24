import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentMetalClient, PaymentRequiredError, ApiError, type FetchLike } from '../src/client.ts';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records calls and returns scripted responses. */
function recorder(handler: (url: string, init?: RequestInit) => Response): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return handler(url, init);
  };
  return { fetch, calls };
}

const SERVER = {
  id: 'srv_1',
  status: 'running',
  plan: 'nano',
  ipv4: '1.2.3.4',
  ssh: 'root@1.2.3.4',
  expires_at: '2026-06-20T00:00:00.000Z',
  renew: 'POST /v1/servers/srv_1/extend',
};

test('provision posts plan/days through payFetch and returns the server on 201', async () => {
  const { fetch, calls } = recorder(() => json(201, SERVER));
  const c = new AgentMetalClient({ baseUrl: 'https://api.agentmetal.dev', payFetch: fetch });
  const r = await c.provision({ plan: 'nano', days: 7 });
  assert.equal(r.ipv4, '1.2.3.4');
  assert.equal(r.id, 'srv_1');
  assert.equal(calls[0]!.url, 'https://api.agentmetal.dev/v1/servers');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { plan: 'nano', days: 7 });
});

test('provision forwards ssh_key and via when given', async () => {
  const { fetch, calls } = recorder(() => json(201, SERVER));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  await c.provision({ plan: 'small', days: 3, sshKey: 'ssh-ed25519 AAA', via: 'claude-skill' });
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    plan: 'small', days: 3, ssh_key: 'ssh-ed25519 AAA', via: 'claude-skill',
  });
});

test('provision forwards managed_key and surfaces the one-time private key', async () => {
  const { fetch, calls } = recorder(() => json(201, { ...SERVER, ssh_private_key: 'PRIV' }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  const r = await c.provision({ plan: 'nano', days: 1, managedKey: true });
  assert.equal(r.ssh_private_key, 'PRIV');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { plan: 'nano', days: 1, managed_key: true });
});

test('exec POSTs /exec with command + timeout and the account bearer, returning the result shape', async () => {
  const { fetch, calls } = recorder(() => json(200, { exit_code: 0, stdout: 'ok', stderr: '', timed_out: false }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, apiKey: 'am_live_abc' });
  const r = await c.exec('srv_1', 'whoami', 5);
  assert.deepEqual(r, { exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  assert.equal(calls[0]!.url, 'https://api/v1/servers/srv_1/exec');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer am_live_abc');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { command: 'whoami', timeout_seconds: 5 });
});

test('exec omits timeout_seconds when not given', async () => {
  const { fetch, calls } = recorder(() => json(200, { exit_code: 0, stdout: '', stderr: '', timed_out: false }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, apiKey: 'am_live_abc' });
  await c.exec('srv_1', 'uptime');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { command: 'uptime' });
});

test('provision surfaces an unpayable 402 as PaymentRequiredError', async () => {
  const { fetch } = recorder(() => json(402, { accepts: [] }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  await assert.rejects(() => c.provision({ plan: 'nano', days: 1 }), (err: unknown) => {
    assert.ok(err instanceof PaymentRequiredError);
    assert.match((err as Error).message, /payment/i);
    return true;
  });
});

test('provision maps other error envelopes to ApiError', async () => {
  const { fetch } = recorder(() => json(400, { error: 'invalid_request', message: 'bad plan' }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  await assert.rejects(() => c.provision({ plan: 'nano', days: 1 }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 400);
    assert.equal((err as ApiError).code, 'invalid_request');
    return true;
  });
});

test('get uses the plain fetch, not payFetch', async () => {
  const pay = recorder(() => json(500, {}));
  const plain = recorder(() => json(200, SERVER));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: pay.fetch, fetch: plain.fetch });
  const r = await c.get('srv_1');
  assert.equal(r.status, 'running');
  assert.equal(pay.calls.length, 0);
  assert.equal(plain.calls[0]!.url, 'https://api/v1/servers/srv_1');
});

test('list unwraps the {servers} envelope and passes the wallet query', async () => {
  const { fetch, calls } = recorder(() => json(200, { servers: [SERVER, { ...SERVER, id: 'srv_2' }] }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  const servers = await c.list({ wallet: '0xPAYER' });
  assert.equal(servers.length, 2);
  assert.equal(servers[1]!.id, 'srv_2');
  assert.equal(calls[0]!.url, 'https://api/v1/servers?wallet=0xPAYER');
});

test('extend posts days through payFetch', async () => {
  const { fetch, calls } = recorder(() => json(200, SERVER));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  await c.extend('srv_1', 5);
  assert.equal(calls[0]!.url, 'https://api/v1/servers/srv_1/extend');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { days: 5 });
});

test('destroy sends the account bearer token', async () => {
  const { fetch, calls } = recorder(() => json(200, { id: 'srv_1', status: 'destroyed' }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, apiKey: 'am_live_abc' });
  const r = await c.destroy('srv_1');
  assert.equal(r.status, 'destroyed');
  assert.equal(calls[0]!.init.method, 'DELETE');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer am_live_abc');
});

test('getCatalog fetches /v1/catalog via the plain fetch (no payFetch)', async () => {
  const catalog = {
    plans: [{ id: 'nano', vcpu: 2, memory_gb: 2, disk_gb: 40, usd_per_day: '0.70', usd_per_month: 20 }],
    locations: [{ code: 'ash', city: 'Ashburn', country: 'US' }],
    bandwidth: { included_tb: 20, extra_usd_per_tb: '2.00' },
    storage: { usd_per_gb_day: '0.01', min_gb: 10, max_gb: 1000 },
  };
  const pay = recorder(() => json(500, {}));
  const plain = recorder(() => json(200, catalog));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: pay.fetch, fetch: plain.fetch });
  const r = await c.getCatalog();
  assert.equal(r.plans[0]!.id, 'nano');
  assert.equal(r.locations[0]!.city, 'Ashburn');
  assert.equal(pay.calls.length, 0);
  assert.equal(plain.calls[0]!.url, 'https://api/v1/catalog');
});

test('reboot POSTs /reboot with the account bearer token', async () => {
  const { fetch, calls } = recorder(() => json(200, { id: 'srv_1', status: 'rebooting' }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, apiKey: 'am_live_abc' });
  const r = await c.reboot('srv_1');
  assert.equal(r.status, 'rebooting');
  assert.equal(calls[0]!.url, 'https://api/v1/servers/srv_1/reboot');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer am_live_abc');
});

test('diagnostics GETs /diagnostics and returns the full shape', async () => {
  const diag = {
    id: 'srv_1', status: 'running', ipv4: '1.2.3.4',
    recent_actions: [{ command: 'reboot_server', status: 'success', progress: 100, error: null }],
    console: { wss_url: 'wss://c', password: 'pw' }, metrics: { cpu: 0.42 },
  };
  const { fetch, calls } = recorder(() => json(200, diag));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, apiKey: 'am_live_abc' });
  const r = await c.diagnostics('srv_1');
  assert.equal(r.console!.wss_url, 'wss://c');
  assert.equal(r.metrics.cpu, 0.42);
  assert.equal(calls[0]!.url, 'https://api/v1/servers/srv_1/diagnostics');
});

test('claim then verifyClaim round-trips email + code', async () => {
  const { fetch, calls } = recorder((url) =>
    url.endsWith('/claim') ? json(200, { sent: true }) : json(200, { account: 'acc_1', api_key: 'am_live_xyz', servers_claimed: 0 }),
  );
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  assert.equal((await c.claim('a@b.co')).sent, true);
  const v = await c.verifyClaim({ email: 'a@b.co', code: '123456' });
  assert.equal(v.api_key, 'am_live_xyz');
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { email: 'a@b.co', code: '123456' });
});

test('provision forwards os when given', async () => {
  const { fetch, calls } = recorder(() => json(201, SERVER));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch });
  await c.provision({ plan: 'nano', days: 1, os: 'debian-12' });
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { plan: 'nano', days: 1, os: 'debian-12' });
});

test('getFirewall GETs the firewall with the account bearer', async () => {
  const { fetch, calls } = recorder(() => json(200, { id: 'srv_1', managed: true, rules: [{ protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0'] }] }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, fetch, apiKey: 'am_live_abc' });
  const r = await c.getFirewall('srv_1');
  assert.equal(calls[0]!.url, 'https://api/v1/servers/srv_1/firewall');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer am_live_abc');
  assert.equal(r.managed, true);
});

test('manageFirewall open POSTs the rule; close DELETEs; force is forwarded', async () => {
  const { fetch, calls } = recorder(() => json(200, { id: 'srv_1', managed: true, rules: [] }));
  const c = new AgentMetalClient({ baseUrl: 'https://api', payFetch: fetch, fetch, apiKey: 'am_live_abc' });
  await c.manageFirewall({ id: 'srv_1', action: 'open', protocol: 'tcp', port: '443' });
  assert.equal(calls[0]!.url, 'https://api/v1/servers/srv_1/firewall/rules');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { protocol: 'tcp', port: '443' });
  await c.manageFirewall({ id: 'srv_1', action: 'close', protocol: 'tcp', port: '22', force: true });
  assert.equal(calls[1]!.init.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { protocol: 'tcp', port: '22', force: true });
});
