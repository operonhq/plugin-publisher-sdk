import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { OperonRetryableError } from "@operon/sdk";
import { createOperonPublisherSDK, parseOperonUrl, isLocalhost, type OperonPublisherSDK } from "../client.js";
import type { ImpressionContext, PlacementDetails } from "../types.js";

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/**
 * Read a setting, accepting both the legacy and new names. New names from
 * the v0.2.0 mapping table (OPERON_API_URL, OPERON_CATEGORY, OPERON_INTENT)
 * are checked first; legacy names (OPERON_URL, OPERON_DEFAULT_CATEGORY,
 * OPERON_DEFAULT_INTENT) fall through so existing characters keep working.
 *
 * Wraps runtime.getSetting so a runtime that throws on an unknown key is
 * tolerated - the plugin must never crash the agent.
 */
function getSetting(runtime: IAgentRuntime, ...keys: string[]): string | null {
  for (const key of keys) {
    let v: unknown;
    try {
      v = runtime.getSetting(key);
    } catch {
      continue;
    }
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-runtime SDK cache
// ---------------------------------------------------------------------------

const sdkCache = new WeakMap<IAgentRuntime, OperonPublisherSDK | false>();
// Per-runtime "have we logged a failure yet?" so an integrator gets one
// loud signal that the plugin is silently failing without console flooding.
const firstFailureLogged = new WeakSet<IAgentRuntime>();

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

  let parsed: URL;
  try {
    parsed = parseOperonUrl(trimmedUrl);
  } catch (err) {
    console.error(
      "[operon-publisher] " + (err instanceof Error ? err.message : String(err)) +
      ". Plugin disabled."
    );
    sdkCache.set(runtime, false);
    return null;
  }

  // Hostname-based check - rejects http://localhost.evil.com which a
  // startsWith("http://localhost") guard would let through.
  if (parsed.protocol !== "https:" && !isLocalhost(parsed)) {
    if (getSetting(runtime, "OPERON_ALLOW_HTTP") === "true") {
      console.warn(
        `[operon-publisher] url is not HTTPS (host=${parsed.hostname}). OPERON_ALLOW_HTTP is set - continuing, but credentials may be exposed.`
      );
    } else {
      console.error(
        `[operon-publisher] url must use HTTPS in production (host=${parsed.hostname}). Set OPERON_ALLOW_HTTP=true to override. Plugin disabled.`
      );
      sdkCache.set(runtime, false);
      return null;
    }
  }

  const publisherName =
    getSetting(runtime, "OPERON_PUBLISHER_NAME") ??
    (typeof runtime.character?.name === "string" ? runtime.character.name : undefined);
  const source = getSetting(runtime, "OPERON_SOURCE") ?? undefined;

  let instance: OperonPublisherSDK;
  try {
    instance = createOperonPublisherSDK({
      url: trimmedUrl,
      apiKey: key?.trim(),
      publisherName,
      source,
      onRetryable: (err: OperonRetryableError) => {
        // Fired by the SDK on 503 + Retry-After. Surface to integrators so
        // backoff signals don't disappear into stderr noise.
        console.warn(
          `[operon-publisher] server requested backoff: retry-after=${err.retryAfterMs}ms`
        );
      },
    });
  } catch (err) {
    console.error(
      "[operon-publisher] SDK init failed: " +
      (err instanceof Error ? err.message : String(err)) +
      ". Plugin disabled."
    );
    sdkCache.set(runtime, false);
    return null;
  }

  sdkCache.set(runtime, instance);

  if (!key) {
    // Sandbox mode (no API key). Always log once at warn level so a
    // typo'd key doesn't silently downgrade traffic to unauthenticated.
    console.warn(
      `[operon-publisher] Running in SANDBOX mode (OPERON_API_KEY not set). Traffic to ${parsed.hostname} is unauthenticated.`
    );
  } else if (getSetting(runtime, "OPERON_DEBUG") === "true") {
    console.log(`[operon-publisher] Connected to ${parsed.hostname}`);
  }

  return instance;
}

// ---------------------------------------------------------------------------
// Impression context builder
// ---------------------------------------------------------------------------

function getMessageText(message: Memory): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { text?: string } | undefined)?.text ?? "";
}

function buildImpressionContext(
  runtime: IAgentRuntime,
  publisherName: string,
  text: string
): ImpressionContext {
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
 * Defense-in-depth note: every field flowing in here is clampString'd in
 * client.ts, which strips newlines and any literal [SPONSORED_CONTENT_*]
 * markers, so a hostile campaign cannot forge the fence and inject
 * instructions outside the sandboxed block.
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

const EMPTY: { text: string } = { text: "" };

function classifyError(err: unknown): string {
  if (err instanceof OperonRetryableError) return `server-backoff (${err.retryAfterMs}ms)`;
  if (err instanceof Error) {
    if (err.message.includes("circuit breaker")) return "circuit-open";
    if (/timeout|abort/i.test(err.message)) return "timeout";
    const m = err.message.match(/Operon (\d{3}):/);
    if (m) return `http-${m[1]}`;
    return err.name || "error";
  }
  return "unknown";
}

/**
 * OPERON_PLACEMENT provider.
 *
 * Fires on every message. Delegates network, identity, attribution, and
 * circuit-breaker concerns to @operon/sdk; this provider is responsible for
 * mapping ElizaOS settings/messages to the SDK and injecting the formatted
 * placement back into the agent's state.
 *
 * Reliability contract: this function MUST NOT throw. Any failure path
 * returns { text: "" } so the agent responds normally.
 */
export const operonPlacementProvider: Provider = {
  name: "OPERON_PLACEMENT",
  description: "Sponsored placement from Operon ad network - injects quality-gated sponsored content into agent responses",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<{ text: string } | null> => {
    try {
      // Short-circuit for empty / whitespace-only messages: the SDK
      // requires a non-empty placement_context and would throw, flooding
      // stderr and tripping the circuit breaker on attachment-only or
      // system-generated messages.
      const text = getMessageText(message);
      if (!text.trim()) return EMPTY;

      const client = ensureSDK(runtime);
      if (!client) return EMPTY;

      const publisherName =
        getSetting(runtime, "OPERON_PUBLISHER_NAME") ??
        (typeof runtime.character?.name === "string" ? runtime.character.name : "unknown");

      const context = buildImpressionContext(runtime, publisherName, text);

      const result = await client.requestPlacement(context);

      if (result.decision === "filled") {
        return { text: formatPlacement(result.placement) };
      }

      return EMPTY;
    } catch (err) {
      const klass = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
      // First failure per runtime gets a louder warn so silent failures
      // surface in container logs without explicit OPERON_DEBUG.
      if (!firstFailureLogged.has(runtime)) {
        firstFailureLogged.add(runtime);
        console.warn(
          `[operon-publisher] First placement failure for this runtime (class=${klass}): ${msg}`
        );
      } else if (getSetting(runtime, "OPERON_DEBUG") === "true") {
        console.error(`[operon-publisher] Placement request failed (class=${klass}): ${msg}`);
      }
      return EMPTY;
    }
  },
};
