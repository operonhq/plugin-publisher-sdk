// src/providers/operonPlacement.ts
import { OperonRetryableError as OperonRetryableError2 } from "@operon/sdk";

// src/client.ts
import { initOperon } from "@operon/sdk";
var MAX_STRING_FIELD_LENGTH = 500;
var STRIP_RE = new RegExp(
  "[\\x00-\\x1f\\x7f\\u0085\\u200b-\\u200f\\u202a-\\u202e\\u2028\\u2029\\u2060-\\u2064\\u2066-\\u2069\\ufeff]",
  "g"
);
var FENCE_RE = /\[SPONSORED_CONTENT_(START|END)\]/gi;
function clampString(val, maxLen = MAX_STRING_FIELD_LENGTH) {
  if (typeof val !== "string") return "";
  return val.replace(STRIP_RE, "").replace(FENCE_RE, "").slice(0, maxLen);
}
function clampNumber(val, min, max) {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0;
  return Math.max(min, Math.min(max, val));
}
function validateUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`[operon-publisher] Invalid url: ${clampString(input, 80)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[operon-publisher] url must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("[operon-publisher] url must not contain credentials");
  }
  return parsed;
}
function isLocalhost(parsed) {
  const h = parsed.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}
function parseOperonUrl(input) {
  return validateUrl(input);
}
function sanitizeUrl(val, maxLen) {
  const s = clampString(val, maxLen);
  if (!s) return "";
  try {
    const url = new URL(s);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}
function sanitizeClickUrl(val) {
  const sanitized = sanitizeUrl(val, 500);
  if (val && typeof val === "string" && val.trim() && !sanitized) {
    console.warn(`[operon-publisher] clickUrl rejected by sanitizeUrl: ${val.slice(0, 80).replace(/[\r\n\t]/g, " ")}`);
  }
  if (!sanitized) return null;
  return sanitized.replace(/[()\[\]<> `\\]/g, (c) => encodeURIComponent(c));
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
    clickUrl: sanitizeClickUrl(p.clickUrl),
    scoutScore: p.scoutScore != null ? clampNumber(p.scoutScore, 0, 100) : null,
    rank: clampNumber(p.rank, 0, 1e4),
    bidPrice: clampNumber(p.bidPrice, 0, 1e6)
  };
}
function createOperonPublisherSDK(urlOrOptions, apiKey) {
  const opts = typeof urlOrOptions === "string" ? { url: urlOrOptions, apiKey } : urlOrOptions;
  validateUrl(opts.url);
  const operon = initOperon({
    url: opts.url,
    apiKey: opts.apiKey,
    publisherName: opts.publisherName,
    source: opts.source,
    timeoutMs: opts.timeoutMs,
    onRetryable: opts.onRetryable
  });
  return {
    async requestPlacement(context) {
      const query = context.requestContext.query ?? "";
      const sdkContext = {
        placement_context: query,
        category: context.requestContext.category,
        asset: context.requestContext.asset,
        amount: context.requestContext.amount,
        intent: context.requestContext.intent,
        sentiment: context.responseContext.sentiment,
        actions: context.responseContext.actions
      };
      const data = await operon.getPlacement(query, sdkContext);
      if (!data || typeof data !== "object" || !("decision" in data)) {
        throw new Error(
          "Operon returned invalid placement response: missing decision field"
        );
      }
      if (data.decision === "filled") {
        const placement = validatePlacement(data.placement);
        const auction = validateAuction(data.auction);
        return {
          decision: "filled",
          reason: clampString(data.reason),
          placement,
          auction
        };
      }
      if (data.decision === "blocked") {
        return {
          decision: "blocked",
          reason: clampString(data.reason)
        };
      }
      throw new Error(
        `Operon returned unknown decision: ${String(data.decision)}`
      );
    }
  };
}

// src/providers/operonPlacement.ts
function getSetting(runtime, ...keys) {
  for (const key of keys) {
    let v;
    try {
      v = runtime.getSetting(key);
    } catch {
      continue;
    }
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return null;
}
var sdkCache = /* @__PURE__ */ new WeakMap();
var firstFailureLogged = /* @__PURE__ */ new WeakSet();
function ensureSDK(runtime) {
  if (sdkCache.has(runtime)) {
    const cached = sdkCache.get(runtime);
    return cached === false ? null : cached;
  }
  const url = getSetting(runtime, "OPERON_API_URL", "OPERON_URL");
  if (!url) {
    console.warn(
      "[operon-publisher] OPERON_API_URL (or legacy OPERON_URL) is required. Plugin disabled for this runtime."
    );
    sdkCache.set(runtime, false);
    return null;
  }
  const key = getSetting(runtime, "OPERON_API_KEY") ?? void 0;
  const trimmedUrl = url.trim();
  let parsed;
  try {
    parsed = parseOperonUrl(trimmedUrl);
  } catch (err) {
    console.error(
      "[operon-publisher] " + (err instanceof Error ? err.message : String(err)) + ". Plugin disabled."
    );
    sdkCache.set(runtime, false);
    return null;
  }
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
  const publisherName = getSetting(runtime, "OPERON_PUBLISHER_NAME") ?? (typeof runtime.character?.name === "string" ? runtime.character.name : void 0);
  const source = getSetting(runtime, "OPERON_SOURCE") ?? void 0;
  let instance;
  try {
    instance = createOperonPublisherSDK({
      url: trimmedUrl,
      apiKey: key?.trim(),
      publisherName,
      source,
      onRetryable: (err) => {
        console.warn(
          `[operon-publisher] server requested backoff: retry-after=${err.retryAfterMs}ms`
        );
      }
    });
  } catch (err) {
    console.error(
      "[operon-publisher] SDK init failed: " + (err instanceof Error ? err.message : String(err)) + ". Plugin disabled."
    );
    sdkCache.set(runtime, false);
    return null;
  }
  sdkCache.set(runtime, instance);
  if (!key) {
    console.warn(
      `[operon-publisher] Running in SANDBOX mode (OPERON_API_KEY not set). Traffic to ${parsed.hostname} is unauthenticated.`
    );
  } else if (getSetting(runtime, "OPERON_DEBUG") === "true") {
    console.log(`[operon-publisher] Connected to ${parsed.hostname}`);
  }
  return instance;
}
function getMessageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content?.text ?? "";
}
function buildImpressionContext(runtime, publisherName, text) {
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
    placement.clickUrl ? `- Click URL: ${placement.clickUrl}` : placement.routable && placement.endpoint ? `- Endpoint: ${placement.endpoint}` : null,
    placement.clickUrl ? `Include this service as a recommendation with a clickable Markdown link using the Click URL above. Do not omit the link.` : null,
    `[SPONSORED_CONTENT_END]`
  ].filter(Boolean).join("\n");
}
var EMPTY = { text: "" };
function classifyError(err) {
  if (err instanceof OperonRetryableError2) return `server-backoff (${err.retryAfterMs}ms)`;
  if (err instanceof Error) {
    if (err.message.includes("circuit breaker")) return "circuit-open";
    if (/timeout|abort/i.test(err.message)) return "timeout";
    const m = err.message.match(/Operon (\d{3}):/);
    if (m) return `http-${m[1]}`;
    return err.name || "error";
  }
  return "unknown";
}
var operonPlacementProvider = {
  name: "OPERON_PLACEMENT",
  description: "Sponsored placement from Operon ad network - injects quality-gated sponsored content into agent responses",
  get: async (runtime, message, _state) => {
    try {
      const text = getMessageText(message);
      if (!text.trim()) return EMPTY;
      const client = ensureSDK(runtime);
      if (!client) return EMPTY;
      const publisherName = getSetting(runtime, "OPERON_PUBLISHER_NAME") ?? (typeof runtime.character?.name === "string" ? runtime.character.name : "unknown");
      const context = buildImpressionContext(runtime, publisherName, text);
      const result = await client.requestPlacement(context);
      if (result.decision === "filled") {
        return { text: formatPlacement(result.placement) };
      }
      return EMPTY;
    } catch (err) {
      const klass = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
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