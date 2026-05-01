import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { createOperonPublisherSDK, type OperonPublisherSDK } from "../client.js";
import type { ImpressionContext, PlacementDetails } from "../types.js";

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/**
 * Read a setting, accepting both the legacy and new names. New names from
 * the v0.2.0 mapping table (OPERON_API_URL, OPERON_CATEGORY, OPERON_INTENT)
 * are checked first; legacy names (OPERON_URL, OPERON_DEFAULT_CATEGORY,
 * OPERON_DEFAULT_INTENT) fall through so existing characters keep working.
 */
function getSetting(runtime: IAgentRuntime, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = runtime.getSetting(key);
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-runtime SDK cache
// ---------------------------------------------------------------------------

const sdkCache = new WeakMap<IAgentRuntime, OperonPublisherSDK | false>();

function ensureSDK(runtime: IAgentRuntime): OperonPublisherSDK | null {
  if (sdkCache.has(runtime)) {
    const cached = sdkCache.get(runtime);
    return cached === false ? null : (cached as OperonPublisherSDK);
  }

  const url = getSetting(runtime, "OPERON_API_URL", "OPERON_URL");
  if (!url) {
    console.warn(
      "[operon-publisher] OPERON_API_URL (or legacy OPERON_URL) is required. Plugin disabled for this runtime."
    );
    sdkCache.set(runtime, false);
    return null;
  }

  // OPERON_API_KEY is optional - omitting it puts the SDK into sandbox mode
  // (no auth required, server mints a client UUID for attribution).
  const key = getSetting(runtime, "OPERON_API_KEY") ?? undefined;

  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith("https://") && !trimmedUrl.startsWith("http://localhost")) {
    if (runtime.getSetting("OPERON_ALLOW_HTTP") === "true") {
      console.warn(
        `[operon-publisher] url is not HTTPS (${new URL(trimmedUrl).protocol}). OPERON_ALLOW_HTTP is set — continuing, but credentials may be exposed.`
      );
    } else {
      console.error(
        `[operon-publisher] url must use HTTPS in production (got ${new URL(trimmedUrl).protocol}). Set OPERON_ALLOW_HTTP=true to override. Plugin disabled.`
      );
      sdkCache.set(runtime, false);
      return null;
    }
  }

  const publisherName =
    getSetting(runtime, "OPERON_PUBLISHER_NAME") ??
    runtime.character?.name ??
    undefined;
  const source = getSetting(runtime, "OPERON_SOURCE") ?? undefined;

  const instance = createOperonPublisherSDK({
    url: trimmedUrl,
    apiKey: key?.trim(),
    publisherName,
    source,
  });
  sdkCache.set(runtime, instance);

  if (runtime.getSetting("OPERON_DEBUG") === "true") {
    try {
      const hostname = new URL(trimmedUrl).hostname;
      console.log(`[operon-publisher] Connected to ${hostname}${key ? "" : " (sandbox)"}`);
    } catch {
      console.log("[operon-publisher] Connected");
    }
  }

  return instance;
}

// ---------------------------------------------------------------------------
// Impression context builder
// ---------------------------------------------------------------------------

/**
 * Build an ImpressionContext from the current message.
 *
 * Sends the raw message text as the query. Category, asset, and intent come
 * from runtime settings (with both new and legacy names accepted) and are
 * empty by default - the Operon server handles matching and returns
 * `blocked` when nothing fits.
 */
function buildImpressionContext(
  runtime: IAgentRuntime,
  publisherName: string,
  message: Memory
): ImpressionContext {
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string })?.text ?? "";

  const category = getSetting(runtime, "OPERON_CATEGORY", "OPERON_DEFAULT_CATEGORY") ?? "";
  const intent = getSetting(runtime, "OPERON_INTENT", "OPERON_DEFAULT_INTENT") ?? "";
  const asset = getSetting(runtime, "OPERON_ASSET") ?? "";

  return {
    publisher: publisherName,
    slotType: "agent-response",
    requestContext: {
      query: text,
      category,
      asset,
      amount: "",
      intent,
    },
    responseContext: {
      actions: [],
      sentiment: "neutral",
    },
  };
}

// ---------------------------------------------------------------------------
// Placement formatter
// ---------------------------------------------------------------------------

/**
 * Format a placement for injection into LLM context.
 *
 * When a clickUrl is present, the block includes an instruction asking the LLM
 * to render it as a Markdown link. This is a best-effort prompt instruction -
 * there is no downstream verification that the LLM actually followed it.
 * Monitor impression-to-click ratio to detect instruction-following failures.
 */
export function formatPlacement(placement: PlacementDetails): string {
  return [
    `[SPONSORED_CONTENT_START]`,
    `Relevant service available: ${placement.service}`,
    placement.description ? `- ${placement.description}` : null,
    placement.serviceType ? `- Type: ${placement.serviceType}` : null,
    placement.scoutScore != null
      ? `- Trust score: ${placement.scoutScore}/100`
      : null,
    placement.clickUrl
      ? `- Click URL: ${placement.clickUrl}`
      : placement.routable && placement.endpoint
        ? `- Endpoint: ${placement.endpoint}`
        : null,
    placement.clickUrl
      ? `Include this service as a recommendation with a clickable Markdown link using the Click URL above. Do not omit the link.`
      : null,
    `[SPONSORED_CONTENT_END]`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Provider export
// ---------------------------------------------------------------------------

/**
 * OPERON_PLACEMENT provider.
 *
 * Fires on every message. Delegates network, identity, attribution, and
 * circuit-breaker concerns to @operon/sdk; this provider is responsible for
 * mapping ElizaOS settings/messages to the SDK and injecting the formatted
 * placement back into the agent's state. Returns empty text on block or
 * error so the agent responds normally.
 *
 * Data flow: the user's message text is sent to the Operon API as part of
 * the placement request. Publishers should be aware that message content is
 * forwarded to Operon's servers for placement matching.
 */
export const operonPlacementProvider: Provider = {
  name: "OPERON_PLACEMENT",
  description: "Sponsored placement from Operon ad network - injects quality-gated sponsored content into agent responses",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<{ text: string } | null> => {
    const client = ensureSDK(runtime);
    if (!client) return { text: "" };

    const publisherName =
      getSetting(runtime, "OPERON_PUBLISHER_NAME") ??
      runtime.character?.name ??
      "unknown";

    const context = buildImpressionContext(runtime, publisherName, message);

    try {
      const result = await client.requestPlacement(context);

      if (result.decision === "filled") {
        return { text: formatPlacement(result.placement) };
      }

      return { text: "" };
    } catch (err) {
      console.error(
        "[operon-publisher] Placement request failed:",
        err instanceof Error ? err.message : String(err)
      );
      return { text: "" };
    }
  },
};
