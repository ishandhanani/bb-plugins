// A small Slack client for the bridge: Web API calls and a Socket Mode
// connection, with no SDK. Socket Mode keeps an outbound WebSocket open, so
// bb needs no public URL; every envelope is acknowledged at once and handled
// after, so a slow handler never makes Slack retry.

export interface SlackEnvelope {
  type: string;
  payload: Record<string, unknown>;
}

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string, details: string[] = []) {
    super(`slack ${method}: ${code}${details.length > 0 ? ` (${details.join("; ")})` : ""}`);
  }
}

/** POST a Web API method; waits out 429s (Retry-After) up to three times. */
export async function slackApi<T = Record<string, unknown>>(base: string, token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Form-encoded, because Slack's read methods ignore JSON bodies; blocks and other objects go as JSON strings.
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) if (value !== undefined) form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    const response = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` },
      body: form,
    });
    if (response.status === 429 && attempt < 3) {
      const wait = Number(response.headers.get("retry-after") ?? "1");
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait) * 1000));
      continue;
    }
    const data = (await response.json()) as { ok?: boolean; error?: string; response_metadata?: { messages?: string[] } } & T;
    if (!data.ok) throw new SlackApiError(method, data.error ?? `http ${response.status}`, data.response_metadata?.messages ?? []);
    return data;
  }
}

/**
 * Hold a Socket Mode connection until `signal` aborts: open a URL with the app
 * token, acknowledge each envelope, hand it to `onEnvelope`, and reconnect
 * (with backoff) when Slack asks or the socket drops.
 */
export async function runSocketMode(opts: {
  base: string;
  appToken: string;
  signal: AbortSignal;
  onEnvelope: (envelope: SlackEnvelope) => void;
  log: (message: string) => void;
}): Promise<void> {
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      const { url } = await slackApi<{ url: string }>(opts.base, opts.appToken, "apps.connections.open");
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(url);
        const close = () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
          resolve();
        };
        opts.signal.addEventListener("abort", close, { once: true });
        ws.addEventListener("close", () => opts.signal.removeEventListener("abort", close));
        ws.addEventListener("open", () => {
          failures = 0;
        });
        ws.addEventListener("message", (event) => {
          let message: { type?: string; envelope_id?: string; payload?: Record<string, unknown>; reason?: string };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.type === "disconnect") {
            opts.log(`socket mode: slack asked to reconnect (${message.reason ?? "no reason"})`);
            close();
            return;
          }
          if (message.envelope_id) ws.send(JSON.stringify({ envelope_id: message.envelope_id }));
          if (message.type && message.type !== "hello" && message.payload) opts.onEnvelope({ type: message.type, payload: message.payload });
        });
        ws.addEventListener("close", () => resolve());
        ws.addEventListener("error", () => resolve());
      });
    } catch (cause) {
      failures++;
      opts.log(`socket mode: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (opts.signal.aborted) break;
    // Back off on repeated failures; reconnect quickly after a requested refresh.
    const wait = Math.min(60_000, failures === 0 ? 500 : 1_000 * 2 ** Math.min(failures, 6));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
