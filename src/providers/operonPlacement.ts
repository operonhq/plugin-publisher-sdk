import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { createOperonPublisherSDK, type OperonPublisherSDK } from "../client.js";
import type { ImpressionContext, PlacementDetails } from "../types.js";

/** Per-runtime SDK cache. Each runtime gets its own client keyed to its credentials. */
const sdkCache = new WeakMap<IAgentRuntime, OperonPublisherSDK | false>();

function ensureSDK(runtime: IAgentRuntime): OperonPublisherSDK | null {
  if (sdkCache.has(runtime)) {
    const cached = sdkCache.get(runtime);
    return cached === false ? null : (cached as OperonPublisherSDK);
  }

  const url = runtime.getSetting("OPERON_URL");
  const key = runtime.getSetting("OPERON_API_KEY");

  if (!url || !key) {
    console.warn(
      "[operon-publisher] OPERON_URL and OPERON_API_KEY are required. Plugin disabled for this runtime."
    );
    sdkCache.set(runtime, false);
    return null;
  }

  const instance = createOperonPublisherSDK(url, key);
  sdkCache.set(runtime, instance);
  console.log(`[operon-publisher] Connected to ${url}`);
  return instance;
}

/**
 * Build an ImpressionContext from the current message.
 *
 * v1: sends the raw message text as the query with default context fields.
 * The Operon server handles matching and returns `blocked` when nothing
 * fits, so sending best-effort context on every message is safe.
 * Category, asset, amount, and intent extraction will improve in v2.
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
    placement.description ? `- ${placement.description}` : null,
    placement.serviceType ? `- Type: ${placement.serviceType}` : null,
    placement.scoutScore != null
      ? `- Trust score: ${placement.scoutScore}/100`
      : null,
    placement.routable && placement.endpoint
      ? `- Endpoint: ${placement.endpoint}`
      : null,
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
