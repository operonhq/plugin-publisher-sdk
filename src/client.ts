import type { AuctionResult, ImpressionContext, OperonPlacementResponse, PlacementDetails } from "./types.js";

export interface OperonPublisherSDK {
  requestPlacement(
    context: ImpressionContext
  ): Promise<OperonPlacementResponse>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_STRING_FIELD_LENGTH = 500;
const MAX_ERROR_BODY_LENGTH = 200;

/** Clamp a string field to a safe length, stripping control characters */
export function clampString(val: unknown, maxLen = MAX_STRING_FIELD_LENGTH): string {
  if (typeof val !== "string") return "";
  return val.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").slice(0, maxLen);
}

/** Clamp a number to a safe range */
export function clampNumber(val: unknown, min: number, max: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0;
  return Math.max(min, Math.min(max, val));
}

/** Validate and normalize a URL string, allowing only http/https protocols */
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

/** Sanitize a clickUrl, warning when a non-empty value is rejected */
function sanitizeClickUrl(val: unknown): string | null {
  const sanitized = sanitizeUrl(val, 500);
  if (val && typeof val === "string" && val.trim() && !sanitized) {
    console.warn(`[operon-publisher] clickUrl rejected by sanitizeUrl: ${val.slice(0, 80).replace(/[\r\n\t]/g, " ")}`);
  }
  return sanitized || null;
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
    // Range [0, 10_000] matches the auction ranking entries; should match the server's API contract
    rank: clampNumber(p.rank, 0, 10_000),
    bidPrice: clampNumber(p.bidPrice, 0, 1_000_000),
  };
}

export function createOperonPublisherSDK(
  operonUrl: string,
  apiKey: string
): OperonPublisherSDK {
  // Validate URL at construction time so callers bypassing ensureSDK still get safety checks
  let parsed: URL;
  try {
    parsed = new URL(operonUrl);
  } catch {
    throw new Error(`[operon-publisher] Invalid OPERON_URL: ${clampString(operonUrl, 80)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[operon-publisher] OPERON_URL must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("[operon-publisher] OPERON_URL must not contain credentials");
  }
  const baseUrl = operonUrl.replace(/\/+$/, "");

  return {
    async requestPlacement(
      context: ImpressionContext
    ): Promise<OperonPlacementResponse> {
      const response = await fetch(`${baseUrl}/placement`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ impressionContext: context }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const truncated = body.slice(0, MAX_ERROR_BODY_LENGTH);
        throw new Error(
          `Operon placement request failed: ${response.status} ${response.statusText}${truncated ? ` - ${truncated}` : ""}`
        );
      }

      const data: unknown = await response.json();

      if (!data || typeof data !== "object" || !("decision" in data)) {
        throw new Error(
          "Operon returned invalid placement response: missing decision field"
        );
      }

      const obj = data as Record<string, unknown>;

      if (obj.decision === "filled") {
        const placement = validatePlacement(obj.placement);
        const auction = validateAuction(obj.auction);

        return {
          decision: "filled",
          reason: clampString(obj.reason),
          placement,
          auction,
        };
      }

      if (obj.decision === "blocked") {
        return {
          decision: "blocked",
          reason: clampString(obj.reason),
        };
      }

      throw new Error(
        `Operon returned unknown decision: ${String(obj.decision)}`
      );
    },
  };
}
