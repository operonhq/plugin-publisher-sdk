import type { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { createOperonPublisherSDK, type OperonPublisherSDK } from "../client.js";
import type { ImpressionContext, PlacementDetails } from "../types.js";

// ---------------------------------------------------------------------------
// Per-runtime SDK cache
// ---------------------------------------------------------------------------

const sdkCache = new WeakMap<IAgentRuntime, OperonPublisherSDK | false>();

function ensureSDK(runtime: IAgentRuntime): OperonPublisherSDK | null {
  if (sdkCache.has(runtime)) {
    const cached = sdkCache.get(runtime);
    return cached === false ? null : (cached as OperonPublisherSDK);
  }

  const url = runtime.getSetting("OPERON_URL");
  const key = runtime.getSetting("OPERON_API_KEY");

  if (!url || !key || !url.trim() || !key.trim()) {
    console.warn(
      "[operon-publisher] OPERON_URL and OPERON_API_KEY are required. Plugin disabled for this runtime."
    );
    sdkCache.set(runtime, false);
    return null;
  }

  if (!url.startsWith("https://") && !url.startsWith("http://localhost")) {
    console.warn(
      `[operon-publisher] OPERON_URL should use HTTPS. Got: ${new URL(url).protocol}. Continuing, but credentials may be exposed.`
    );
  }

  const instance = createOperonPublisherSDK(url.trim(), key.trim());
  sdkCache.set(runtime, instance);

  // Log hostname only, not full URL (avoids leaking query params)
  try {
    const hostname = new URL(url).hostname;
    console.log(`[operon-publisher] Connected to ${hostname}`);
  } catch {
    console.log("[operon-publisher] Connected");
  }

  return instance;
}

// ---------------------------------------------------------------------------
// Circuit breaker - stops hammering Operon when it's down
// ---------------------------------------------------------------------------

export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 30_000;

interface CircuitState {
  failures: number;
  openUntil: number;
  halfOpen: boolean;
}

const circuitStates = new WeakMap<IAgentRuntime, CircuitState>();

export function getCircuit(runtime: IAgentRuntime): CircuitState {
  let state = circuitStates.get(runtime);
  if (!state) {
    state = { failures: 0, openUntil: 0, halfOpen: false };
    circuitStates.set(runtime, state);
  }
  return state;
}

export function isCircuitOpen(circuit: CircuitState): boolean {
  if (circuit.failures < CIRCUIT_FAILURE_THRESHOLD) return false;
  if (Date.now() > circuit.openUntil) {
    if (circuit.halfOpen) return true; // probe already in flight
    // Cooldown expired - enter half-open state and allow a single probe
    circuit.halfOpen = true;
    return false;
  }
  return true;
}

export function recordSuccess(circuit: CircuitState): void {
  circuit.failures = 0;
  circuit.halfOpen = false;
  circuit.openUntil = 0;
}

export function recordFailure(circuit: CircuitState): void {
  if (circuit.halfOpen) {
    // Half-open probe failed - re-open circuit immediately
    circuit.halfOpen = false;
    circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    return;
  }
  if (circuit.failures < CIRCUIT_FAILURE_THRESHOLD) {
    circuit.failures++;
  }
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD && circuit.openUntil < Date.now()) {
    circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
}

// ---------------------------------------------------------------------------
// Impression context builder
// ---------------------------------------------------------------------------

/**
 * Build an ImpressionContext from the current message.
 *
 * v1: sends the raw message text as the query. Category and intent are
 * configurable via runtime settings (OPERON_DEFAULT_CATEGORY,
 * OPERON_DEFAULT_INTENT) with fallback defaults. The Operon server handles
 * matching and returns `blocked` when nothing fits.
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

  const category = runtime.getSetting("OPERON_DEFAULT_CATEGORY") ?? "";
  const intent = runtime.getSetting("OPERON_DEFAULT_INTENT") ?? "";

  return {
    publisher: publisherName,
    slotType: "agent-response",
    requestContext: {
      query: text,
      category,
      asset: "",
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

function formatPlacement(placement: PlacementDetails): string {
  return [
    `[SPONSORED_CONTENT_START]`,
    `Relevant service available: ${placement.service}`,
    placement.description ? `- ${placement.description}` : null,
    placement.serviceType ? `- Type: ${placement.serviceType}` : null,
    placement.scoutScore != null
      ? `- Trust score: ${placement.scoutScore}/100`
      : null,
    placement.routable && placement.endpoint
      ? `- Endpoint: ${placement.endpoint}`
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
 * Fires on every message. Calls Operon's /placement endpoint and injects
 * sponsored placement context into the agent's state when a match is found.
 * Returns nothing when blocked or on error - the agent responds normally.
 *
 * Data flow: the user's message text is sent to the Operon API as part of
 * the placement request. Publishers should be aware that message content is
 * forwarded to Operon's servers for placement matching.
 */
export const operonPlacementProvider: Provider = {
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<string | null> => {
    const client = ensureSDK(runtime);
    if (!client) return null;

    const circuit = getCircuit(runtime);
    if (isCircuitOpen(circuit)) return null;

    const publisherName =
      runtime.getSetting("OPERON_PUBLISHER_NAME") ??
      runtime.character?.name ??
      "unknown";

    const context = buildImpressionContext(runtime, publisherName, message);

    try {
      const result = await client.requestPlacement(context);
      recordSuccess(circuit);

      if (result.decision === "filled") {
        return formatPlacement(result.placement);
      }

      return null;
    } catch (err) {
      recordFailure(circuit);
      console.error(
        "[operon-publisher] Placement request failed:",
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  },
};
