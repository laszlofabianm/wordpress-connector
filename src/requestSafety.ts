const WINDOW_MS = 30_000;
export const MAX_UPLOAD_BYTES = 32_000_000;

export class WordPressApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown, code?: string) {
    super(message);
    this.name = "WordPressApiError";
    this.status = status;
    this.payload = payload;
    if (code !== undefined) this.code = code;
  }
}

export class WordPressRequestPolicyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WordPressRequestPolicyError";
  }
}

interface Circuit {
  status: 403 | 429;
  blockedAt: number;
  retryAt?: number;
}

export interface WordPressRequestSafetyState {
  hostname: string;
  maxConcurrency: number;
  maxRequestsPer30Seconds: number;
  activeRequests: number;
  queuedRequests: number;
  circuit: Readonly<Circuit> | null;
}

export class WordPressRequestBlockedError extends WordPressApiError {
  readonly hostname: string;
  readonly blockedAt: number;
  readonly retryAt?: number;

  constructor(hostname: string, circuit: Circuit) {
    super(
      `WordPress requests to ${hostname} are stopped after HTTP ${circuit.status}. ` +
      "No automatic retry was sent. Resolve the server restriction before explicitly resetting the circuit.",
      circuit.status,
      { hostname, ...circuit },
      "wordpress_request_circuit_open"
    );
    this.name = "WordPressRequestBlockedError";
    this.hostname = hostname;
    this.blockedAt = circuit.blockedAt;
    if (circuit.retryAt !== undefined) this.retryAt = circuit.retryAt;
  }
}

export function safetyLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new WordPressRequestPolicyError(
      `${name} must be an integer between 1 and ${maximum}.`,
      "wordpress_invalid_safety_limit"
    );
  }
  return limit;
}

function decodeRoute(value: string): string {
  // Repeated encoding must not turn a forbidden route into an allowed URL.
  while (true) {
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { break; }
    if (decoded === value) break;
    value = decoded;
  }
  return value.replace(/\\/g, "/");
}

export function assertIndividualEndpoint(url: URL): void {
  const candidates = [url.pathname];
  url.searchParams.forEach((value, key) => {
    if (decodeRoute(key).toLowerCase() === "rest_route") candidates.push(value);
  });
  if (candidates.some(route => /(?:^|\/)batch\/v1(?:\/|$|[?#])/i.test(decodeRoute(route)))) {
    throw new WordPressRequestPolicyError(
      "The WordPress /batch/v1 endpoint is disabled. Send individual posts, pages, media, or plugin endpoint requests instead.",
      "wordpress_batch_disabled"
    );
  }
}

type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void };

/** One host-wide budget per loaded module/process, shared across credentials and site paths. */
export class HostRequestSafety {
  private active = 0;
  private starts: number[] = [];
  private queue: Waiter[] = [];
  private circuit: Circuit | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly hostname: string,
    private maxConcurrency: number,
    private maxRequestsPer30Seconds: number
  ) {}

  tighten(maxConcurrency: number, maxRequestsPer30Seconds: number): void {
    this.maxConcurrency = Math.min(this.maxConcurrency, maxConcurrency);
    this.maxRequestsPer30Seconds = Math.min(this.maxRequestsPer30Seconds, maxRequestsPer30Seconds);
  }

  acquire(): Promise<() => void> {
    if (this.circuit) return Promise.reject(new WordPressRequestBlockedError(this.hostname, this.circuit));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.pump();
    });
  }

  assertRunning(): void {
    if (this.circuit) throw new WordPressRequestBlockedError(this.hostname, this.circuit);
  }

  stop(status: 403 | 429, retryAfter: string | null): void {
    const now = Date.now();
    let retryAt: number | undefined;
    if (retryAfter !== null) {
      const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
      const parsed = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(retryAfter);
      if (Number.isFinite(parsed)) retryAt = Math.max(now, parsed);
    }
    // A later in-flight response may only extend the restriction, never clear/shorten it.
    const oldRetryAt = this.circuit?.retryAt;
    if (oldRetryAt !== undefined) retryAt = Math.max(oldRetryAt, retryAt ?? oldRetryAt);
    this.circuit = {
      status,
      blockedAt: this.circuit?.blockedAt ?? now,
      ...(retryAt === undefined ? {} : { retryAt }),
    };
    this.pump();
  }

  reset(): void {
    if (this.circuit?.retryAt !== undefined && this.circuit.retryAt > Date.now()) {
      throw new WordPressRequestBlockedError(this.hostname, this.circuit);
    }
    this.circuit = null;
    // Keep the rolling rate budget: resetting a circuit cannot create a fresh burst allowance.
    this.pump();
  }

  state(): WordPressRequestSafetyState {
    return {
      hostname: this.hostname,
      maxConcurrency: this.maxConcurrency,
      maxRequestsPer30Seconds: this.maxRequestsPer30Seconds,
      activeRequests: this.active,
      queuedRequests: this.queue.length,
      circuit: this.circuit ? { ...this.circuit } : null,
    };
  }

  private pump(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.circuit) {
      const queue = this.queue.splice(0);
      for (const item of queue) item.reject(new WordPressRequestBlockedError(this.hostname, this.circuit));
      return;
    }
    const now = Date.now();
    this.starts = this.starts.filter(start => now - start < WINDOW_MS);
    while (this.active < this.maxConcurrency && this.starts.length < this.maxRequestsPer30Seconds && this.queue.length) {
      const item = this.queue.shift()!;
      this.active++;
      this.starts.push(now);
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
    if (this.queue.length && this.active < this.maxConcurrency && this.starts.length >= this.maxRequestsPer30Seconds) {
      this.timer = setTimeout(() => this.pump(), Math.max(1, this.starts[0]! + WINDOW_MS - now));
    }
  }
}

const hosts = new Map<string, HostRequestSafety>();
export function hostRequestSafety(hostname: string, concurrency: number, requests: number): HostRequestSafety {
  const key = hostname.toLowerCase().replace(/\.$/, "");
  const previous = hosts.get(key);
  if (previous) { previous.tighten(concurrency, requests); return previous; }
  const safety = new HostRequestSafety(key, concurrency, requests);
  hosts.set(key, safety);
  return safety;
}
