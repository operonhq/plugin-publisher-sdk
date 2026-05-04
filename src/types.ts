/** Impression context payload sent to Operon */
export interface ImpressionContext {
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
export interface TrustScoreResult {
  domain: string;
  score: number;
  level: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
  flags: string[];
}

/** @deprecated Renamed to TrustScoreResult. Will be removed in a future major version. */
export type ScoutScoreResult = TrustScoreResult;

/** Placement details returned when Operon fills a slot */
export interface PlacementDetails {
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
export interface AuctionResult {
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
export type OperonPlacementResponse =
  | {
      decision: "filled";
      reason: string;
      placement: PlacementDetails;
      auction: AuctionResult;
    }
  | {
      decision: "blocked";
      reason: string;
    };
