import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { createOperonPublisherSDK, type OperonPublisherSDK } from "../client.js";
import type { ImpressionContext, PlacementDetails } from "../types.js";

let sdk: OperonPublisherSDK | null = null;
let initAttempted = false;

function ensureSDK(runtime: IAgentRuntime): OperonPublisherSDK | null {
  if (sdk) return sdk;
  if (initAttempted) return null;

  initAttempted = true;

  const url = runtime.getSetting("OPERON_URL");
  const key = runtime.getSetting("OPERON_API_KEY");

  if (!url || !key) {
    console.warn(
      "[operon-publisher] OPERON_URL and OPERON_API_KEY are required. Plugin disabled."
    );
    return null;
  }

  sdk = createOperonPublisherSDK(url, key);
  console.log(`[operon-publisher] Connected to ${url}`);
  return sdk;
}

/**
 * Build an ImpressionContext from the current message.
 *
 * v1: extracts what we can from the raw message text. The Operon server
 * handles matching and returns `blocked` when nothing fits, so sending
 * a best-effort context on every message is safe.
 */
function buildImpressionContext(
  publisherName: string,
  message: Memory
): ImpressionContext {
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string })?.text ?? "";

  return {
    publisher: publisherName,
    slotType: "agent-response",
    requestContext: {
      query: text,
      category: "defi",
      asset: "",
      amount: "",
      intent: "research",
    },
    responseContext: {
      actions: [],
      sentiment: "neutral",
    },
  };
}

function formatPlacement(placement: PlacementDetails): string {
  return [
    `[Sponsored] Relevant service available: ${placement.service}`,
    `- ${placement.description}`,
    `- Type: ${placement.serviceType}`,
    `- Trust score: ${placement.scoutScore}/100`,
    placement.routable ? `- Endpoint: ${placement.endpoint}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * OPERON_PLACEMENT provider.
 *
 * Fires on every message. Calls Operon's /placement endpoint and injects
 * sponsored placement context into the agent's state when a match is found.
 * Returns nothing when blocked or on error - the agent responds normally.
 */
export const operonPlacementProvider: Provider = {
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<string | null> => {
    const client = ensureSDK(runtime);
    if (!client) return null;

    const publisherName =
      runtime.getSetting("OPERON_PUBLISHER_NAME") ??
      (runtime as unknown as { character?: { name?: string } }).character
        ?.name ??
      "unknown";

    const context = buildImpressionContext(publisherName, message);

    try {
      const result = await client.requestPlacement(context);

      if (result.decision === "filled") {
        return formatPlacement(result.placement);
      }

      return null;
    } catch {
      // Placement failures are non-fatal - agent responds normally
      return null;
    }
  },
};
