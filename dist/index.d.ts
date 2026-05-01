import { Plugin } from '@elizaos/core';

/** Impression context payload sent to Operon */
interface ImpressionContext {
    publisher: string;
    slotType: string;
    requestContext: {
        query: string;
        category: string;
        asset: string;
        amount: string;
        intent: string;
    };
    responseContext: {
        actions: string[];
        sentiment: string;
    };
}
/**
 * Trust result for a demand-side agent.
 *
 * Note: the wire field is still `scoutScore` for backward compatibility with
 * the Operon server. The TypeScript type is named `TrustScoreResult` and
 * `PlacementDetails.scoutScore` keeps its name on the wire; user-facing copy
 * (README, formatPlacement output) uses "Trust score".
 */
interface TrustScoreResult {
    domain: string;
    score: number;
    level: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
    flags: string[];
}
/** @deprecated Renamed to TrustScoreResult. Will be removed in a future major version. */
type ScoutScoreResult = TrustScoreResult;
/** Placement details returned when Operon fills a slot */
interface PlacementDetails {
    sponsored: boolean;
    service: string;
    serviceType: string;
    category: string;
    description: string;
    routable: boolean;
    endpoint: string;
    clickUrl: string | null;
    /** Server-side trust score (0-100). Wire field name retained for compatibility. */
    scoutScore: number | null;
    rank: number;
    bidPrice: number;
}
/** Auction metadata returned with filled placements */
interface AuctionResult {
    candidates: number;
    eligible: number;
    winner: string;
    ranking: Array<{
        service: string;
        score: number;
        bid: number;
        rank: number;
        eligible: boolean;
        reason: string;
    }>;
}
/** Operon placement response - discriminated union on `decision` */
type OperonPlacementResponse = {
    decision: "filled";
    reason: string;
    placement: PlacementDetails;
    auction: AuctionResult;
} | {
    decision: "blocked";
    reason: string;
};

interface OperonPublisherSDK {
    requestPlacement(context: ImpressionContext): Promise<OperonPlacementResponse>;
}
interface CreateOperonPublisherSDKOptions {
    url: string;
    apiKey?: string;
    publisherName?: string;
    source?: string;
    timeoutMs?: number;
}
/**
 * Create a thin adapter that delegates network, identity, attribution, and
 * circuit-breaker concerns to @operon/sdk. The adapter preserves the v0.1.x
 * `requestPlacement(ImpressionContext)` shape so callers don't have to change.
 *
 * Sandbox lane: if `apiKey` is omitted, the underlying SDK runs in sandbox
 * mode (mints a client UUID at ~/.operon/client.json, no auth required).
 */
declare function createOperonPublisherSDK(urlOrOptions: string | CreateOperonPublisherSDKOptions, apiKey?: string): OperonPublisherSDK;

declare const operonPublisherPlugin: Plugin;

export { type AuctionResult, type ImpressionContext, type OperonPlacementResponse, type OperonPublisherSDK, type PlacementDetails, type ScoutScoreResult, type TrustScoreResult, createOperonPublisherSDK, operonPublisherPlugin as default };
