import type { RunEvent } from "@min-atoms/protocol";

export interface StreamCredentials {
  token: string;
  streamUrl: string;
}

export interface SubscribeRunEventsOptions {
  /** Fetches a fresh SSE token; called on every (re)connect. */
  fetchCredentials: () => Promise<StreamCredentials>;
  /** Project-level cursor; events with id <= getAfter() are not resent. */
  getAfter: () => number;
  onEvent: (id: number, event: RunEvent) => void;
  /** Reconnect backoff; defaults to 1s/2s/4s… capped at 10s. */
  reconnectDelayMs?: (attempt: number) => number;
  /**
   * Tokens expire after 10 minutes (protocol SSE_TOKEN_TTL_SECONDS), so an
   * open connection is transparently renewed shortly before that.
   */
  renewAfterMs?: number;
}

/**
 * EventSource wrapper for `GET /projects/:id/stream?token=&after=`:
 * manual reconnect with `after` resume (EventSource would otherwise reuse the
 * stale URL cursor), fresh token on every reconnect, and periodic renewal.
 */
export function subscribeRunEvents(options: SubscribeRunEventsOptions): () => void {
  const { fetchCredentials, getAfter, onEvent } = options;
  const reconnectDelayMs = options.reconnectDelayMs ?? ((attempt: number) => Math.min(10_000, 1000 * 2 ** attempt));
  const renewAfterMs = options.renewAfterMs ?? 9 * 60 * 1000;

  let closed = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const clearTimers = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (renewTimer !== null) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
  };

  const closeSource = () => {
    source?.close();
    source = null;
  };

  const scheduleReconnect = () => {
    closeSource();
    if (closed) return;
    const wait = reconnectDelayMs(attempts);
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      void connect();
    }, wait);
  };

  const connect = async () => {
    if (closed) return;
    closeSource();
    clearTimers();
    let credentials: StreamCredentials;
    try {
      credentials = await fetchCredentials();
    } catch {
      scheduleReconnect();
      return;
    }
    if (closed) return;
    // streamUrl already carries ?token= (manager.ts streamUrl); set both
    // params through URL so renewals replace the token instead of appending a
    // second query string.
    const url = new URL(credentials.streamUrl);
    url.searchParams.set("token", credentials.token);
    url.searchParams.set("after", String(getAfter()));
    const events = new EventSource(url.toString());
    source = events;
    events.addEventListener("run-event", (raw) => {
      attempts = 0;
      try {
        const parsed = JSON.parse((raw as MessageEvent).data) as { id?: unknown; event?: RunEvent };
        if (typeof parsed.id === "number" && parsed.event && typeof parsed.event.kind === "string") {
          onEvent(parsed.id, parsed.event);
        }
      } catch {
        // Ignore malformed frames; the next reconnect replays from `after`.
      }
    });
    events.onopen = () => {
      attempts = 0;
    };
    events.onerror = () => {
      if (!closed) scheduleReconnect();
    };
    renewTimer = setTimeout(() => {
      void connect();
    }, renewAfterMs);
  };

  void connect();

  return () => {
    closed = true;
    clearTimers();
    closeSource();
  };
}
