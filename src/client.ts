import { initOperon, type OperonClient, type PlacementContext } from "@operon/sdk";
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
}

const MAX_STRING_FIELD_LENGTH = 500;

/** Clamp a string field to a safe length, stripping control characters */
export function clampString(val: unknown, maxLen = MAX_STRING_FIELD_LENGTH): string {
  if (typeof val !== "string") return "";
  return val.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁠-⁤﻿]/g, "").slice(0, maxLen);
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

  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new Error(`[operon-publisher] Invalid url: ${clampString(opts.url, 80)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[operon-publisher] url must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("[operon-publisher] url must not contain credentials");
  }

  const operon: OperonClient = initOperon({
    url: opts.url,
    apiKey: opts.apiKey,
    publisherName: opts.publisherName,
    source: opts.source,
    timeoutMs: opts.timeoutMs,
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
