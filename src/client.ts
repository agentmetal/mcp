/**
 * Thin typed client for the AgentMetal HTTP API.
 *
 * Paid routes (provision, extend) go through `payFetch` — an x402-wrapped fetch that
 * answers a 402 by signing a USDC payment and retrying. Unpaid routes (status, claim,
 * destroy) use a plain fetch. The split is injected so the client stays testable.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentMetalClientConfig {
  baseUrl: string;
  /** x402-wrapped fetch used for paid endpoints. */
  payFetch: FetchLike;
  /** Plain fetch for unpaid endpoints. Defaults to payFetch, then globalThis.fetch. */
  fetch?: FetchLike;
  /** Account API key (am_live_…) for account-scoped routes like destroy. */
  apiKey?: string;
}

/** A provisioned server as returned by the API (flat shape, snake_case fields). */
export interface Server {
  id: string;
  status: string;
  plan: string;
  // Network details are present only for the authenticated owner; anonymous lookups (by ?wallet=,
  // or an unauthenticated GET of someone else's box) omit them entirely — hence optional, not just nullable.
  ipv4?: string | null;
  ssh?: string | null;
  expires_at: string;
  renew: string;
  payment?: { amount_atomic: string; tx_hash?: string };
  /** Present ONCE on provision with managed_key:true — the managed private key, shown only here. */
  ssh_private_key?: string;
}

/** The result of running a command on a server via exec. */
export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

/** The public catalog: plans, offered locations, and add-on pricing. */
export interface Catalog {
  plans: { id: string; vcpu: number; memory_gb: number; disk_gb: number; usd_per_day: string; usd_per_month: number }[];
  locations: { code: string; city: string; country: string }[];
  bandwidth: { included_tb: number; extra_usd_per_tb: string };
  storage: { usd_per_gb_day: string; min_gb: number; max_gb: number };
}

/** Hypervisor-level diagnostics: recent actions, a VNC console, and live metrics. */
export interface Diagnostics {
  id: string;
  status: string;
  ipv4: string | null;
  recent_actions: { command: string; status: string; progress: number; error: string | null }[];
  console: { wss_url: string; password: string } | null;
  metrics: Record<string, number | null>;
}

export interface ProvisionInput {
  plan: 'nano' | 'small' | 'medium';
  days: number;
  /** OS image, e.g. "ubuntu-24.04" (default) or "debian-12". See get_catalog for the list. */
  os?: string;
  /** SSH public key to authorize on the box. */
  sshKey?: string;
  /** Generate a server-side keypair, authorize it, and return the private key once (enables exec). */
  managedKey?: boolean;
  /** Free-form attribution tag (e.g. the calling skill/agent). */
  via?: string;
}

/** A box's inbound firewall rule. */
export interface FirewallRule {
  protocol: string;
  port?: string;
  source_ips: string[];
  description?: string;
}

/** The box's edge-firewall view: rules when edge-managed, or a note when it isn't. */
export interface FirewallView {
  id: string;
  managed: boolean;
  rules?: FirewallRule[];
  note?: string;
  opened?: FirewallRule;
  closed?: FirewallRule;
}

export interface ManageFirewallInput {
  id: string;
  action: 'open' | 'close';
  protocol: string;
  port?: string;
  sourceIps?: string[];
  description?: string;
  force?: boolean;
}

export class PaymentRequiredError extends Error {
  readonly status = 402;
  constructor(message = 'payment required and could not be completed') {
    super(message);
    this.name = 'PaymentRequiredError';
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class AgentMetalClient {
  readonly #baseUrl: string;
  readonly #payFetch: FetchLike;
  readonly #fetch: FetchLike;
  readonly #apiKey?: string;

  constructor(config: AgentMetalClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#payFetch = config.payFetch;
    this.#fetch = config.fetch ?? config.payFetch;
    if (config.apiKey) this.#apiKey = config.apiKey;
  }

  /** Provision a server. Pays via x402 when the API answers 402. */
  async provision(input: ProvisionInput): Promise<Server> {
    const body: Record<string, unknown> = { plan: input.plan, days: input.days };
    if (input.os) body.os = input.os;
    if (input.sshKey) body.ssh_key = input.sshKey;
    if (input.managedKey) body.managed_key = true;
    if (input.via) body.via = input.via;
    const res = await this.#payFetch(`${this.#baseUrl}/v1/servers`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    return this.#parse<Server>(res);
  }

  /**
   * List a fleet. Pass a wallet to list that payer's servers; omit it to list the
   * account's servers (requires config.apiKey).
   */
  async list(opts: { wallet?: string } = {}): Promise<Server[]> {
    const q = opts.wallet ? `?wallet=${encodeURIComponent(opts.wallet)}` : '';
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers${q}`, { headers: this.#headers() });
    const data = await this.#parse<{ servers: Server[] }>(res);
    return data.servers;
  }

  /** Fetch the public catalog: plans, locations, and add-on pricing. Free — no auth, no payment. */
  async getCatalog(): Promise<Catalog> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/catalog`, { headers: this.#headers() });
    return this.#parse<Catalog>(res);
  }

  /** Soft-reboot a server. Requires an account API key (set via config.apiKey). */
  async reboot(id: string): Promise<{ id: string; status: string }> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}/reboot`, {
      method: 'POST',
      headers: this.#headers(),
    });
    return this.#parse<{ id: string; status: string }>(res);
  }

  /**
   * Run a command as root on a managed-key server via SSH. Requires an account API key
   * (config.apiKey) and a server provisioned with managed_key:true. Bounded by `timeoutSeconds`.
   */
  async exec(id: string, command: string, timeoutSeconds?: number): Promise<ExecResult> {
    const body: Record<string, unknown> = { command };
    if (timeoutSeconds !== undefined) body.timeout_seconds = timeoutSeconds;
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    return this.#parse<ExecResult>(res);
  }

  /** Hypervisor-level diagnostics for a server. Requires an account API key (set via config.apiKey). */
  async diagnostics(id: string): Promise<Diagnostics> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}/diagnostics`, {
      headers: this.#headers(),
    });
    return this.#parse<Diagnostics>(res);
  }

  /** List a server's edge-firewall rules. Requires an account API key + ownership (off-box). */
  async getFirewall(id: string): Promise<FirewallView> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}/firewall`, {
      headers: this.#headers(),
    });
    return this.#parse<FirewallView>(res);
  }

  /** Open or close a port on a server's edge firewall. Requires an account API key + ownership. */
  async manageFirewall(input: ManageFirewallInput): Promise<FirewallView> {
    const body: Record<string, unknown> = { protocol: input.protocol };
    if (input.port !== undefined) body.port = input.port;
    if (input.sourceIps) body.source_ips = input.sourceIps;
    if (input.description) body.description = input.description;
    if (input.force) body.force = true;
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(input.id)}/firewall/rules`, {
      method: input.action === 'open' ? 'POST' : 'DELETE',
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    return this.#parse<FirewallView>(res);
  }

  /** Fetch a server's current status. */
  async get(id: string): Promise<Server> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}`, {
      headers: this.#headers(),
    });
    return this.#parse<Server>(res);
  }

  /** Extend a server's lease by `days`. Pays via x402 when the API answers 402. */
  async extend(id: string, days: number): Promise<Server> {
    const res = await this.#payFetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}/extend`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ days }),
    });
    return this.#parse<Server>(res);
  }

  /** Destroy a server. Requires an account API key (set via config.apiKey). */
  async destroy(id: string): Promise<{ id: string; status: string }> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.#headers(),
    });
    return this.#parse<{ id: string; status: string }>(res);
  }

  /** Start an email claim: the API emails a one-time code. */
  async claim(email: string): Promise<{ sent: boolean }> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/claim`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ email }),
    });
    return this.#parse<{ sent: boolean }>(res);
  }

  /** Complete an email claim, receiving an account API key. Optionally link a wallet — which the API
   *  requires `wallet_signature` to prove control of (see verify_claim tool for the message to sign). */
  async verifyClaim(input: { email: string; code: string; wallet?: string; wallet_signature?: string }): Promise<{ account: string; api_key: string; servers_claimed: number }> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/claim/verify`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(input),
    });
    return this.#parse<{ account: string; api_key: string; servers_claimed: number }>(res);
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#apiKey) h.authorization = `Bearer ${this.#apiKey}`;
    return h;
  }

  async #parse<T>(res: Response): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    if (res.status === 402) {
      // payFetch couldn't satisfy the payment (no/low funds, over cap, no wallet).
      throw new PaymentRequiredError('payment required: the request was answered with HTTP 402 and the payment could not be completed');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `request failed (HTTP ${res.status})`);
  }
}
