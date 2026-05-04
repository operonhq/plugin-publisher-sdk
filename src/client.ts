import { initOperon, OperonRetryableError, type OperonClient, type PlacementContext } from "@operon/sdk";
import type { AuctionResult, ImpressionContext, OperonPlacementResponse, PlacementDetails } from "./types.js";

export interface OperonPublisherSDK {
  requestPlacement(
    context: ImpressionContext
  ): Promise<OperonPlacementResponse>;
}

export interface CreateOperonPublisherSDKOptions {
  url: string;
  apiKey?: string;
  publisherName?: string;
  source?: string;
  timeoutMs?: number;
  /**
   * Forwarded to @operon/sdk. Fired (fire-and-forget) when the server
   * returns 503 + Retry-After. Use for telemetry / observability.
   */
  onRetryable?: (err: OperonRetryableError) => void;
}

const MAX_STRING_FIELD_LENGTH = 500;

// Strip:
//  - all C0 control bytes 0x00-0x1F (this includes \t \n \r -- see comment below)
//  - DEL (0x7F)
//  - U+0085 NEL (next line)
//  - U+200B-U+200F (zero-width + LRM/RLM)
//  - U+202A-U+202E (bidi formatting controls)
//  - U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR
//  - U+2060-U+2064 (invisible separators)
//  - U+FEFF BOM
//
// Newlines are intentionally stripped: every clamped field flows into the
// LLM-context SPONSORED_CONTENT block on its own line. If a hostile campaign
// description carries a literal \n followed by `[SPONSORED_CONTENT_END]`, it
// would forge the closing fence and inject instructions outside the sandbox.
// Strip whitespace controls and the user sees the description as one line.
const STRIP_RE = new RegExp(
  "[" +
    "\\x00-\\x1f" +     // C0 controls (incl. \t \n \r)
    "\\x7f" +           // DEL
    "\\u0085" +         // NEL (next line)
    "\\u200b-\\u200f" + // zero-width + LRM/RLM
    "\\u202a-\\u202e" + // bidi formatting controls
    "\\u2028\\u2029" +  // LINE / PARAGRAPH SEPARATOR
    "\\u2060-\\u2064" + // invisible separators
    "\\u2066-\\u2069" + // bidi isolate controls (LRI/RLI/FSI/PDI, Trojan-Source)
    "\\ufeff" +         // BOM / zero-width no-break space
  "]",
  "g"
);

// Defense-in-depth: prevent attacker-controlled fields from forging the
// sentinel markers used by formatPlacement(), even if a future code change
// allows a newline through clampString. The marker text is fixed; matching
// case-insensitively to be safe.
const FENCE_RE = /\[SPONSORED_CONTENT_(START|END)\]/gi;

/** Clamp a string field to a safe length, stripping control characters and sentinel markers. */
export function clampString(val: unknown, maxLen = MAX_STRING_FIELD_LENGTH): string {
  if (typeof val !== "string") return "";
  return val.replace(STRIP_RE, "").replace(FENCE_RE, "").slice(0, maxLen);
}

/** Clamp a number to a safe range */
export function clampNumber(val: unknown, min: number, max: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0;
  return Math.max(min, Math.min(max, val));
}

/**
 * Validate URL: only http(s), no embedded credentials. Returns the parsed URL
 * for callers that also need hostname-based decisions (HTTPS-vs-localhost).
 */
function validateUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`[operon-publisher] Invalid url: ${clampString(input, 80)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[operon-publisher] url must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("[operon-publisher] url must not contain credentials");
  }
  return parsed;
}

/** True when a parsed URL points at a loopback host. Hostname-based; rejects http://localhost.evil.com. */
export function isLocalhost(parsed: URL): boolean {
  const h = parsed.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Parse + validate a candidate URL string and return the parsed URL. Exported for the provider's HTTPS guard. */
export function parseOperonUrl(input: string): URL {
  return validateUrl(input);
}

/**
 * Validate a generic URL field from untrusted server data; only http/https
 * with no credentials, no other schemes. Length-clamped first.
 */
function sanitizeUrl(val: unknown, maxLen: number): string {
  const s = clampString(val, maxLen);
  if (!s) return "";
  try {
    const url = new URL(s);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Sanitize a clickUrl that the LLM will be told to render as a Markdown link.
 * Beyond the protocol/credential checks, percent-encode characters that could
 * break out of the [label](url) syntax -- `(`, `)`, `[`, `]`, `<`, `>`, ` `,
 * backtick, backslash. Standard `URL.href` already encodes most of these in
 * paths but not always in the query string.
 */
function sanitizeClickUrl(val: unknown): string | null {
  const sanitized = sanitizeUrl(val, 500);
  if (val && typeof val === "string" && val.trim() && !sanitized) {
    console.warn(`[operon-publisher] clickUrl rejected by sanitizeUrl: ${val.slice(0, 80).replace(/[\r\n\t]/g, " ")}`);
  }
  if (!sanitized) return null;
  return sanitized.replace(/[()\[\]<> `\\]/g, (c) => encodeURIComponent(c));
}

const MAX_RANKING_ENTRIES = 50;

/** Validate and sanitize an AuctionResult from untrusted server data */
export function validateAuction(raw: unknown): AuctionResult {
  if (raw === undefined || raw === null) {
    return { candidates: 0, eligible: 0, winner: "", ranking: [] };
  }
  if (typeof raw !== "object") {
    console.warn("[operon-publisher] Auction data present but invalid (not an object)");
    return { candidates: 0, eligible: 0, winner: "", ranking: [] };
  }

  const a = raw as Record<string, unknown>;

  const rawRanking = Array.isArray(a.ranking)
    ? a.ranking.slice(0, MAX_RANKING_ENTRIES)
    : [];

  return {
    candidates: clampNumber(a.candidates, 0, 10_000),
    eligible: clampNumber(a.eligible, 0, 10_000),
    winner: clampString(a.winner, 100),
    ranking: rawRanking.map((entry: unknown) => {
      const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return {
        service: clampString(e.service, 100),
        score: clampNumber(e.score, 0, 100),
        bid: clampNumber(e.bid, 0, 1_000_000),
        rank: clampNumber(e.rank, 0, 10_000),
        eligible: !!e.eligible,
        reason: clampString(e.reason, 200),
      };
    }).filter(entry => entry.service !== ""),
  };
}

/** Validate and sanitize a PlacementDetails object from untrusted server data */
export function validatePlacement(raw: unknown): PlacementDetails {
  if (!raw || typeof raw !== "object") {
    throw new Error("Operon returned filled decision without valid placement data");
  }

  const p = raw as Record<string, unknown>;

  if (typeof p.service !== "string" || !p.service) {
    throw new Error("Operon returned filled decision without valid placement data");
  }

  return {
    sponsored: !!p.sponsored,
    service: clampString(p.service, 100),
    serviceType: clampString(p.serviceType, 100),
    category: clampString(p.category, 100),
    description: clampString(p.description),
    routable: !!p.routable,
    endpoint: sanitizeUrl(p.endpoint, 200),
    clickUrl: sanitizeClickUrl(p.clickUrl),
    scoutScore: p.scoutScore != null ? clampNumber(p.scoutScore, 0, 100) : null,
    rank: clampNumber(p.rank, 0, 10_000),
    bidPrice: clampNumber(p.bidPrice, 0, 1_000_000),
  };
}

/**
 * Create a thin adapter that delegates network, identity, attribution, and
 * circuit-breaker concerns to @operon/sdk. The adapter preserves the v0.1.x
 * `requestPlacement(ImpressionContext)` shape so callers don't have to change.
 *
 * Sandbox lane: if `apiKey` is omitted, the underlying SDK runs in sandbox
 * mode (mints a client UUID at ~/.operon/client.json, no auth required).
 */
export function createOperonPublisherSDK(
  urlOrOptions: string | CreateOperonPublisherSDKOptions,
  apiKey?: string
): OperonPublisherSDK {
  const opts: CreateOperonPublisherSDKOptions =
    typeof urlOrOptions === "string"
      ? { url: urlOrOptions, apiKey }
      : urlOrOptions;

  validateUrl(opts.url);

  const operon: OperonClient = initOperon({
    url: opts.url,
    apiKey: opts.apiKey,
    publisherName: opts.publisherName,
    source: opts.source,
    timeoutMs: opts.timeoutMs,
    onRetryable: opts.onRetryable,
  });

  return {
    async requestPlacement(
      context: ImpressionContext
    ): Promise<OperonPlacementResponse> {
      const query = context.requestContext.query ?? "";
      const sdkContext: PlacementContext = {
        placement_context: query,
        category: context.requestContext.category,
        asset: context.requestContext.asset,
        amount: context.requestContext.amount,
        intent: context.requestContext.intent,
        sentiment: context.responseContext.sentiment,
        actions: context.responseContext.actions,
      };

      const data = await operon.getPlacement(query, sdkContext);

      if (!data || typeof data !== "object" || !("decision" in data)) {
        throw new Error(
          "Operon returned invalid placement response: missing decision field"
        );
      }

      if (data.decision === "filled") {
        const placement = validatePlacement(data.placement);
        const auction = validateAuction(data.auction);

        return {
          decision: "filled",
          reason: clampString(data.reason),
          placement,
          auction,
        };
      }

      if (data.decision === "blocked") {
        return {
          decision: "blocked",
          reason: clampString(data.reason),
        };
      }

      throw new Error(
        `Operon returned unknown decision: ${String((data as { decision: unknown }).decision)}`
      );
    },
  };
}
