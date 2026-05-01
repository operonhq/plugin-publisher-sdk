import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { operonPlacementProvider } from "./operonPlacement.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

// Pin the SDK's client UUID via env so getClientId() never writes to ~/.operon
// during the test run. Set before any module that triggers initOperon imports.
process.env.OPERON_CLIENT_ID = "test-fixed-uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(
  settings: Record<string, string | null> = {}
): IAgentRuntime {
  const defaults: Record<string, string> = {
    OPERON_URL: "https://api.operon.so",
    OPERON_API_KEY: "test-key-123",
    OPERON_PUBLISHER_NAME: "test-publisher",
  };
  const merged: Record<string, string | null> = { ...defaults, ...settings };
  return {
    getSetting: (key: string) => merged[key] ?? null,
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function filledBody(service = "TestService") {
  return {
    decision: "filled",
    reason: "matched",
    placement: {
      sponsored: true,
      service,
      serviceType: "swap",
      category: "defi",
      description: "A great service",
      routable: true,
      endpoint: "https://example.com/api",
      scoutScore: 85,
      rank: 1,
      bidPrice: 100,
    },
    auction: {
      candidates: 3,
      eligible: 2,
      winner: service,
      ranking: [],
    },
  };
}

function filledCampaignBody(service = "ChangeNOW") {
  return {
    decision: "filled",
    reason: "matched",
    placement: {
      sponsored: true,
      service,
      serviceType: "crypto_swap",
      category: "defi",
      description: "Non-custodial swaps for 1000+ coins",
      routable: false,
      endpoint: null,
      clickUrl: "https://api.operon.so/c/imp_test123",
      scoutScore: 0,
      rank: 1,
      bidPrice: 200,
    },
    auction: {
      candidates: 2,
      eligible: 2,
      winner: service,
      ranking: [],
    },
  };
}

function blockedBody() {
  return { decision: "blocked", reason: "no match" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("operonPlacementProvider.get() integration", () => {
  const originalFetch = globalThis.fetch;
  let runtime: IAgentRuntime;
  let message: Memory;

  beforeEach(() => {
    // Each test gets a fresh runtime so the WeakMap-based SDK cache is clean
    runtime = makeRuntime();
    message = makeMessage("What is the best DEX?");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it("returns ProviderResult with placement text when SDK returns filled", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse(filledBody())) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.ok(result, "Expected a non-null result");
    assert.ok(typeof result === "object" && "text" in result, "Expected { text: string }");
    assert.ok(result.text.includes("[SPONSORED_CONTENT_START]"));
    assert.ok(result.text.includes("TestService"));
    assert.ok(result.text.includes("[SPONSORED_CONTENT_END]"));
  });

  it("includes clickUrl and Markdown instruction for campaign-type placements", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse(filledCampaignBody())) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.ok(result, "Expected a non-null result");
    assert.ok(typeof result === "object" && "text" in result, "Expected { text: string }");
    assert.ok(result.text.includes("- Click URL: https://api.operon.so/c/imp_test123"), "Should include clickUrl");
    assert.ok(result.text.includes("clickable Markdown link"), "Should include Markdown instruction");
    assert.ok(!result.text.includes("- Endpoint:"), "Should not include endpoint for campaign-type");
  });

  it("returns empty text when SDK returns blocked", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse(blockedBody())) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.deepEqual(result, { text: "" });
  });

  it("returns empty text on network error (graceful degradation)", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.deepEqual(result, { text: "" });
  });

  it("returns empty text when config is missing (no url set)", async () => {
    const badRuntime = makeRuntime({ OPERON_URL: null });
    globalThis.fetch = mock.fn(async () => jsonResponse(filledBody())) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(badRuntime, message);

    assert.deepEqual(result, { text: "" });
    assert.equal((globalThis.fetch as unknown as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it("works in sandbox lane when OPERON_API_KEY is omitted", async () => {
    const runtime = makeRuntime({ OPERON_API_KEY: null });
    let capturedHeaders: Record<string, string> | null = null;
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return jsonResponse(filledBody());
    }) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.ok(result && "text" in result && result.text.includes("[SPONSORED_CONTENT_START]"));
    assert.ok(capturedHeaders, "expected fetch to be called");
    assert.ok(!("Authorization" in (capturedHeaders as Record<string, string>)), "sandbox lane must not send Authorization");
    assert.ok((capturedHeaders as Record<string, string>)["X-Operon-Client"], "must always send X-Operon-Client");
  });

  it("accepts new setting names (OPERON_API_URL, OPERON_CATEGORY, OPERON_INTENT, OPERON_ASSET)", async () => {
    const runtime = makeRuntime({
      OPERON_URL: null,
      OPERON_API_URL: "https://api.operon.so",
      OPERON_CATEGORY: "defi",
      OPERON_INTENT: "swap",
      OPERON_ASSET: "ETH",
    });
    let captured: { body: { impressionContext: { requestContext: { category: string; intent: string; asset: string } } } } | null = null;
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      captured = { body: JSON.parse(init.body as string) };
      return jsonResponse(filledBody());
    }) as unknown as typeof fetch;

    await operonPlacementProvider.get(runtime, message);

    assert.ok(captured, "expected fetch to be called");
    const ctx = (captured as unknown as { body: { impressionContext: { requestContext: { category: string; intent: string; asset: string } } } }).body.impressionContext.requestContext;
    assert.equal(ctx.category, "defi");
    assert.equal(ctx.intent, "swap");
    assert.equal(ctx.asset, "ETH");
  });

  it("legacy setting names still work (OPERON_DEFAULT_CATEGORY, OPERON_DEFAULT_INTENT)", async () => {
    const runtime = makeRuntime({
      OPERON_DEFAULT_CATEGORY: "gaming",
      OPERON_DEFAULT_INTENT: "research",
    });
    let captured: { body: { impressionContext: { requestContext: { category: string; intent: string } } } } | null = null;
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      captured = { body: JSON.parse(init.body as string) };
      return jsonResponse(filledBody());
    }) as unknown as typeof fetch;

    await operonPlacementProvider.get(runtime, message);

    assert.ok(captured, "expected fetch to be called");
    const ctx = (captured as unknown as { body: { impressionContext: { requestContext: { category: string; intent: string } } } }).body.impressionContext.requestContext;
    assert.equal(ctx.category, "gaming");
    assert.equal(ctx.intent, "research");
  });
});
