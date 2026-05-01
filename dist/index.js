// src/client.ts
import { initOperon } from "@operon/sdk";
var MAX_STRING_FIELD_LENGTH = 500;
function clampString(val, maxLen = MAX_STRING_FIELD_LENGTH) {
  if (typeof val !== "string") return "";
  return val.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁠-⁤﻿]/g, "").slice(0, maxLen);
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
  return sanitized || null;
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
  let parsed;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new Error(`[operon-publisher] Invalid url: ${clampString(opts.url, 80)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[operon-publisher] url must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("[operon-publisher] url must not contain credentials");
  }
  const operon = initOperon({
    url: opts.url,
    apiKey: opts.apiKey,
    publisherName: opts.publisherName,
    source: opts.source,
    timeoutMs: opts.timeoutMs
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
    const v = runtime.getSetting(key);
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return null;
}
var sdkCache = /* @__PURE__ */ new WeakMap();
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
  if (!trimmedUrl.startsWith("https://") && !trimmedUrl.startsWith("http://localhost")) {
    if (runtime.getSetting("OPERON_ALLOW_HTTP") === "true") {
      console.warn(
        `[operon-publisher] url is not HTTPS (${new URL(trimmedUrl).protocol}). OPERON_ALLOW_HTTP is set \u2014 continuing, but credentials may be exposed.`
      );
    } else {
      console.error(
        `[operon-publisher] url must use HTTPS in production (got ${new URL(trimmedUrl).protocol}). Set OPERON_ALLOW_HTTP=true to override. Plugin disabled.`
      );
      sdkCache.set(runtime, false);
      return null;
    }
  }
  const publisherName = getSetting(runtime, "OPERON_PUBLISHER_NAME") ?? runtime.character?.name ?? void 0;
  const source = getSetting(runtime, "OPERON_SOURCE") ?? void 0;
  const instance = createOperonPublisherSDK({
    url: trimmedUrl,
    apiKey: key?.trim(),
    publisherName,
    source
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
function buildImpressionContext(runtime, publisherName, message) {
  const text = typeof message.content === "string" ? message.content : message.content?.text ?? "";
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
var operonPlacementProvider = {
  name: "OPERON_PLACEMENT",
  description: "Sponsored placement from Operon ad network - injects quality-gated sponsored content into agent responses",
  get: async (runtime, message, _state) => {
    const client = ensureSDK(runtime);
    if (!client) return { text: "" };
    const publisherName = getSetting(runtime, "OPERON_PUBLISHER_NAME") ?? runtime.character?.name ?? "unknown";
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