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
  ipv4: string | null;
  ssh: string | null;
  expires_at: string;
  renew: string;
  payment?: { amount_atomic: string; tx_hash?: string };
}

export interface ProvisionInput {
  plan: 'nano' | 'small' | 'medium';
  days: number;
  /** SSH public key to authorize on the box. */
  sshKey?: string;
  /** Free-form attribution tag (e.g. the calling skill/agent). */
  via?: string;
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
    if (input.sshKey) body.ssh_key = input.sshKey;
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

  /** Complete an email claim, receiving an account API key. Optionally link a wallet. */
  async verifyClaim(input: { email: string; code: string; wallet?: string }): Promise<{ account: string; api_key: string; servers_claimed: number }> {
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
