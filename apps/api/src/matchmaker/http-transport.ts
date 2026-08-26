// Provider-neutral HTTP transport seam.
//
// Background: BG3's matchmaker integration uses a managed AI
// provider (Highrise × Impala) behind the provider-neutral AiAdapter
// contract. The adapter must call a remote HTTPS endpoint, but
// automated tests must remain network-free. This module is the
// single seam the adapter uses to issue HTTP requests; tests
// substitute a fake transport that returns canned responses so
// the adapter can be exercised without depending on the live
// Impala service.
//
// The transport deliberately exposes a small, fetch-like surface
// (request + AbortSignal support) so the production adapter can
// implement it with the standard global `fetch` while tests
// implement it with a deterministic in-memory queue.

export interface HttpTransportRequest {
  /** Absolute URL the transport will request. */
  readonly url: string;
  /** HTTP method. */
  readonly method: "GET" | "POST";
  /** Headers the transport will send verbatim. */
  readonly headers: Readonly<Record<string, string>>;
  /** UTF-8 request body. */
  readonly body: string;
  /**
   * Per-request timeout in milliseconds. The transport is
   * responsible for surfacing a timeout as an `HttpTransportError`
   * with `kind: "timeout"` so the caller can route it to the
   * deterministic fallback.
   */
  readonly timeoutMs: number;
}

export interface HttpTransportResponse {
  readonly status: number;
  readonly bodyText: string;
}

export type HttpTransportErrorKind = "network" | "timeout" | "http-status" | "abort";

export class HttpTransportError extends Error {
  constructor(
    message: string,
    public readonly kind: HttpTransportErrorKind,
    /**
     * When `kind === "http-status"`, the upstream HTTP status code.
     * Never used to leak provider internals beyond a coarse-grained
     * failure signal; the caller maps this to the deterministic
     * fallback without echoing the code to clients.
     */
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HttpTransportError";
  }
}

export interface HttpTransport {
  send(request: HttpTransportRequest): Promise<HttpTransportResponse>;
}

/**
 * Production transport backed by the runtime's global `fetch`. The
 * adapter is responsible for setting the timeout via
 * `AbortSignal.timeout` and translating `AbortError` into the
 * timeout error kind. The implementation never logs or echoes the
 * Authorization header, the URL, or the response body — those are
 * caller-controlled and the adapter sanitises anything that
 * crosses a public boundary.
 */
export class FetchHttpTransport implements HttpTransport {
  async send(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new HttpTransportError(
          `HTTP ${response.status} from upstream provider`,
          "http-status",
          response.status,
        );
      }
      return { status: response.status, bodyText };
    } catch (err) {
      if (err instanceof HttpTransportError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpTransportError("Upstream provider timed out", "timeout");
      }
      throw new HttpTransportError(
        `Upstream provider network error: ${err instanceof Error ? err.name : "unknown"}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
