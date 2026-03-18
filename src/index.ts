import type { Plugin } from "@elizaos/core";
import { operonPlacementProvider } from "./providers/operonPlacement.js";

export type {
  ImpressionContext,
  OperonPlacementResponse,
  PlacementDetails,
  AuctionResult,
  ScoutScoreResult,
} from "./types.js";
export type { OperonPublisherSDK } from "./client.js";
export { createOperonPublisherSDK } from "./client.js";

const operonPublisherPlugin: Plugin = {
  name: "operon-publisher",
  description:
    "Monetize agent responses with Operon's quality-weighted sponsored placements",
  providers: [operonPlacementProvider],
};

export default operonPublisherPlugin;
