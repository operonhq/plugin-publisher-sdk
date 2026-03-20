// src/client.ts
var REQUEST_TIMEOUT_MS = 1e4;
var MAX_STRING_FIELD_LENGTH = 500;
var MAX_ERROR_BODY_LENGTH = 200;
function clampString(val, maxLen = MAX_STRING_FIELD_LENGTH) {
  if (typeof val !== "string") return "";
  return val.slice(0, maxLen);
}
function clampNumber(val, min, max) {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0;
  return Math.max(min, Math.min(max, val));
}
function sanitizeUrl(val, maxLen) {
  const s = clampString(val, maxLen);
  if (!s) return "";
  try {
    const url = new URL(s);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return s;
  } catch {
    return "";
  }
}
var MAX_RANKING_ENTRIES = 50;
function validateAuction(raw) {
  if (raw === void 0 || raw === null) {
    return { candidates: 0, eligible: 0, winner: "", ranking: [] };
  }
  if (typeof raw !== "object") {
    console.warn("[operon-publisher] Auction data present but invalid (not an object)");
    return { candidates: 0, eligible: 0, winner: "", ranking: [] };
  }
  const a = raw;
  const rawRanking = Array.isArray(a.ranking) ? a.ranking.slice(0, MAX_RANKING_ENTRIES) : [];
  return {
    candidates: clampNumber(a.candidates, 0, 1e4),
    eligible: clampNumber(a.eligible, 0, 1e4),
    winner: clampString(a.winner, 100),
    ranking: rawRanking.map((entry) => {
      const e = entry && typeof entry === "object" ? entry : {};
      return {
        service: clampString(e.service, 100),
        score: clampNumber(e.score, 0, 100),
        bid: clampNumber(e.bid, 0, 1e6),
        rank: clampNumber(e.rank, 0, 1e4),
        eligible: !!e.eligible,
        reason: clampString(e.reason, 200)
      };
    }).filter((entry) => entry.service !== "")
  };
}
function validatePlacement(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Operon returned filled decision without valid placement data");
  }
  const p = raw;
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
    scoutScore: clampNumber(p.scoutScore, 0, 100),
    // Range [0, 10_000] matches the auction ranking entries; should match the server's API contract
    rank: clampNumber(p.rank, 0, 1e4),
    bidPrice: clampNumber(p.bidPrice, 0, 1e6)
  };
}
function createOperonPublisherSDK(operonUrl, apiKey) {
  const baseUrl = operonUrl.replace(/\/+$/, "");
  return {
    async requestPlacement(context) {
      const response = await fetch(`${baseUrl}/placement`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ impressionContext: context }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const truncated = body.slice(0, MAX_ERROR_BODY_LENGTH);
        throw new Error(
          `Operon placement request failed: ${response.status} ${response.statusText}${truncated ? ` - ${truncated}` : ""}`
        );
      }
      const data = await response.json();
      if (!data || typeof data !== "object" || !("decision" in data)) {
        throw new Error(
          "Operon returned invalid placement response: missing decision field"
        );
      }
      const obj = data;
      if (obj.decision === "filled") {
        const placement = validatePlacement(obj.placement);
        const auction = validateAuction(obj.auction);
        return {
          decision: "filled",
          reason: clampString(obj.reason),
          placement,
          auction
        };
      }
      if (obj.decision === "blocked") {
        return {
          decision: "blocked",
          reason: clampString(obj.reason)
        };
      }
      throw new Error(
        `Operon returned unknown decision: ${String(obj.decision)}`
      );
    }
  };
}

// src/providers/operonPlacement.ts
var sdkCache = /* @__PURE__ */ new WeakMap();
function ensureSDK(runtime) {
  if (sdkCache.has(runtime)) {
    const cached = sdkCache.get(runtime);
    return cached === false ? null : cached;
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
    if (runtime.getSetting("OPERON_ALLOW_HTTP") === "true") {
      console.warn(
        `[operon-publisher] OPERON_URL is not HTTPS (${new URL(url).protocol}). OPERON_ALLOW_HTTP is set \u2014 continuing, but credentials may be exposed.`
      );
    } else {
      console.error(
        `[operon-publisher] OPERON_URL must use HTTPS in production (got ${new URL(url).protocol}). Set OPERON_ALLOW_HTTP=true to override. Plugin disabled.`
      );
      sdkCache.set(runtime, false);
      return null;
    }
  }
  const instance = createOperonPublisherSDK(url.trim(), key.trim());
  sdkCache.set(runtime, instance);
  if (runtime.getSetting("OPERON_DEBUG") === "true") {
    try {
      const hostname = new URL(url).hostname;
      console.log(`[operon-publisher] Connected to ${hostname}`);
    } catch {
      console.log("[operon-publisher] Connected");
    }
  }
  return instance;
}
var CIRCUIT_FAILURE_THRESHOLD = 5;
var CIRCUIT_COOLDOWN_MS = 3e4;
var circuitStates = /* @__PURE__ */ new WeakMap();
function getCircuit(runtime) {
  let state = circuitStates.get(runtime);
  if (!state) {
    state = { failures: 0, openUntil: 0, halfOpen: false };
    circuitStates.set(runtime, state);
  }
  return state;
}
function isCircuitOpen(circuit) {
  if (circuit.failures < CIRCUIT_FAILURE_THRESHOLD) return false;
  if (Date.now() > circuit.openUntil) {
    if (circuit.halfOpen) return true;
    circuit.halfOpen = true;
    return false;
  }
  return true;
}
function recordSuccess(circuit) {
  circuit.failures = 0;
  circuit.halfOpen = false;
  circuit.openUntil = 0;
}
function recordFailure(circuit) {
  if (circuit.halfOpen) {
    circuit.halfOpen = false;
    circuit.failures = CIRCUIT_FAILURE_THRESHOLD;
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
function buildImpressionContext(runtime, publisherName, message) {
  const text = typeof message.content === "string" ? message.content : message.content?.text ?? "";
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
      intent
    },
    responseContext: {
      actions: [],
      sentiment: "neutral"
    }
  };
}
function formatPlacement(placement) {
  return [
    `[SPONSORED_CONTENT_START]`,
    `Relevant service available: ${placement.service}`,
    placement.description ? `- ${placement.description}` : null,
    placement.serviceType ? `- Type: ${placement.serviceType}` : null,
    placement.scoutScore != null ? `- Trust score: ${placement.scoutScore}/100` : null,
    placement.routable && placement.endpoint ? `- Endpoint: ${placement.endpoint}` : null,
    `[SPONSORED_CONTENT_END]`
  ].filter(Boolean).join("\n");
}
var operonPlacementProvider = {
  name: "OPERON_PLACEMENT",
  description: "Sponsored placement from Operon ad network - injects quality-gated sponsored content into agent responses",
  get: async (runtime, message, _state) => {
    const client = ensureSDK(runtime);
    if (!client) return { text: "" };
    const circuit = getCircuit(runtime);
    if (isCircuitOpen(circuit)) return { text: "" };
    const publisherName = runtime.getSetting("OPERON_PUBLISHER_NAME") ?? runtime.character?.name ?? "unknown";
    const context = buildImpressionContext(runtime, publisherName, message);
    try {
      const result = await client.requestPlacement(context);
      recordSuccess(circuit);
      if (result.decision === "filled") {
        return { text: formatPlacement(result.placement) };
      }
      return { text: "" };
    } catch (err) {
      recordFailure(circuit);
      console.error(
        "[operon-publisher] Placement request failed:",
        err instanceof Error ? err.message : String(err)
      );
      return { text: "" };
    }
  }
};

// src/index.ts
var operonPublisherPlugin = {
  name: "operon-publisher",
  description: "Monetize agent responses with Operon's quality-weighted sponsored placements",
  providers: [operonPlacementProvider]
};
var index_default = operonPublisherPlugin;
export {
  createOperonPublisherSDK,
  index_default as default
};
//# sourceMappingURL=index.js.map