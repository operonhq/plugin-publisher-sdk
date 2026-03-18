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

/** ScoutScore trust result for a demand-side agent */
export interface ScoutScoreResult {
  domain: string;
  score: number;
  level: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
  flags: string[];
}

/** Placement details returned when Operon fills a slot */
export interface PlacementDetails {
  sponsored: boolean;
  service: string;
  serviceType: string;
  category: string;
  description: string;
  routable: boolean;
  endpoint: string;
  scoutScore: number;
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
