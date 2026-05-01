import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clampString, clampNumber, validatePlacement, validateAuction, createOperonPublisherSDK } from "./client.js";
import type { ImpressionContext } from "./types.js";

describe("clampString", () => {
  it("returns the string unchanged when within limit", () => {
    assert.equal(clampString("hello"), "hello");
  });

  it("returns empty string for non-string input", () => {
    assert.equal(clampString(42), "");
    assert.equal(clampString(null), "");
    assert.equal(clampString(undefined), "");
    assert.equal(clampString({}), "");
  });

  it("truncates to the specified max length", () => {
    assert.equal(clampString("abcdef", 3), "abc");
  });

  it("strips control characters and Unicode direction overrides", () => {
    assert.equal(clampString("hello\x00world"), "helloworld");
    assert.equal(clampString("safe‮malicious"), "safemalicious");
    assert.equal(clampString("zero​width"), "zerowidth");
    assert.equal(clampString("normal text"), "normal text");
  });

  it("preserves tabs and newlines", () => {
    assert.equal(clampString("line1\nline2"), "line1\nline2");
    assert.equal(clampString("col1\tcol2"), "col1\tcol2");
  });
});

describe("clampNumber", () => {
  it("returns the number when within range", () => {
    assert.equal(clampNumber(5, 0, 10), 5);
  });

  it("returns 0 for non-finite values", () => {
    assert.equal(clampNumber(NaN, 0, 10), 0);
    assert.equal(clampNumber(Infinity, 0, 10), 0);
    assert.equal(clampNumber(-Infinity, 0, 10), 0);
    assert.equal(clampNumber("hello", 0, 10), 0);
    assert.equal(clampNumber(null, 0, 10), 0);
  });

  it("clamps to min when below range", () => {
    assert.equal(clampNumber(-5, 0, 10), 0);
  });

  it("clamps to max when above range", () => {
    assert.equal(clampNumber(20, 0, 10), 10);
  });
});

describe("validatePlacement", () => {
  const validInput = {
    sponsored: true,
    service: "test-service",
    serviceType: "api",
    category: "defi",
    description: "A test service",
    routable: true,
    endpoint: "https://example.com",
    scoutScore: 85,
    rank: 42,
    bidPrice: 1.5,
  };

  it("returns validated placement for valid input", () => {
    const result = validatePlacement(validInput);
    assert.equal(result.service, "test-service");
    assert.equal(result.sponsored, true);
    assert.equal(result.rank, 42);
    assert.equal(result.scoutScore, 85);
  });

  it("returns null scoutScore when server sends null", () => {
    const result = validatePlacement({ ...validInput, scoutScore: null });
    assert.equal(result.scoutScore, null);
  });

  it("returns null scoutScore when server sends undefined", () => {
    const result = validatePlacement({ ...validInput, scoutScore: undefined });
    assert.equal(result.scoutScore, null);
  });

  it("throws when input is null or not an object", () => {
    assert.throws(() => validatePlacement(null));
    assert.throws(() => validatePlacement(undefined));
    assert.throws(() => validatePlacement("string"));
  });

  it("throws when service is missing", () => {
    assert.throws(() => validatePlacement({ ...validInput, service: "" }));
    assert.throws(() => validatePlacement({ ...validInput, service: 123 }));
  });

  it("passes through a valid HTTPS clickUrl", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "https://api.operon.so/c/imp_abc123" });
    assert.equal(result.clickUrl, "https://api.operon.so/c/imp_abc123");
  });

  it("returns null for missing or undefined clickUrl", () => {
    const result = validatePlacement(validInput);
    assert.equal(result.clickUrl, null);

    const result2 = validatePlacement({ ...validInput, clickUrl: undefined });
    assert.equal(result2.clickUrl, null);

    const result3 = validatePlacement({ ...validInput, clickUrl: null });
    assert.equal(result3.clickUrl, null);
  });

  it("rejects javascript: protocol clickUrl", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "javascript:alert(1)" });
    assert.equal(result.clickUrl, null);
  });

  it("rejects data: protocol clickUrl", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "data:text/html,<h1>hi</h1>" });
    assert.equal(result.clickUrl, null);
  });

  it("rejects ftp: protocol clickUrl", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "ftp://example.com/file" });
    assert.equal(result.clickUrl, null);
  });

  it("rejects malformed clickUrl", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "not-a-url" });
    assert.equal(result.clickUrl, null);
  });

  it("allows http clickUrl", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "http://localhost:3000/c/imp_test" });
    assert.equal(result.clickUrl, "http://localhost:3000/c/imp_test");
  });

  it("rejects clickUrl with embedded credentials", () => {
    const result = validatePlacement({ ...validInput, clickUrl: "https://admin:secret@evil.com/" });
    assert.equal(result.clickUrl, null);
  });

  it("rejects endpoint with embedded credentials", () => {
    const result = validatePlacement({ ...validInput, endpoint: "https://user:pass@evil.com/api" });
    assert.equal(result.endpoint, "");
  });
});

describe("validateAuction", () => {
  it("returns validated auction for valid input", () => {
    const result = validateAuction({
      candidates: 10,
      eligible: 5,
      winner: "svc-a",
      ranking: [
        { service: "svc-a", score: 90, bid: 2.0, rank: 1, eligible: true, reason: "best" },
      ],
    });
    assert.equal(result.candidates, 10);
    assert.equal(result.eligible, 5);
    assert.equal(result.winner, "svc-a");
    assert.equal(result.ranking.length, 1);
    assert.equal(result.ranking[0].service, "svc-a");
  });

  it("returns empty default for null/undefined", () => {
    const result = validateAuction(null);
    assert.equal(result.candidates, 0);
    assert.deepEqual(result.ranking, []);

    const result2 = validateAuction(undefined);
    assert.equal(result2.candidates, 0);
  });

  it("returns empty default with warning for non-object", () => {
    const result = validateAuction("not-an-object");
    assert.equal(result.candidates, 0);
    assert.deepEqual(result.ranking, []);
  });

  it("handles malformed ranking entries gracefully", () => {
    const result = validateAuction({
      candidates: 3,
      eligible: 1,
      winner: "w",
      ranking: [null, 42, "bad", { service: "ok", score: 50, bid: 1, rank: 2, eligible: true, reason: "" }],
    });
    assert.equal(result.ranking.length, 1);
    assert.equal(result.ranking[0].service, "ok");
  });

  it("truncates ranking at 50 entries", () => {
    const bigRanking = Array.from({ length: 60 }, (_, i) => ({
      service: `svc-${i}`,
      score: i,
      bid: 1,
      rank: i,
      eligible: true,
      reason: "",
    }));
    const result = validateAuction({
      candidates: 60,
      eligible: 60,
      winner: "svc-0",
      ranking: bigRanking,
    });
    assert.equal(result.ranking.length, 50);
  });
});

// ---------------------------------------------------------------------------
// requestPlacement adapter tests — the HTTP layer is owned by @operon/sdk;
// these tests verify the plugin's adapter correctly maps ImpressionContext
// to the SDK and sanitizes the SDK's loosely-typed response.
// ---------------------------------------------------------------------------

describe("createOperonPublisherSDK adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const dummyContext: ImpressionContext = {
    publisher: "test-pub",
    slotType: "agent-response",
    requestContext: {
      query: "hello",
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

  it("validates URL at construction (rejects invalid)", () => {
    assert.throws(() => createOperonPublisherSDK("not-a-url"));
    assert.throws(() => createOperonPublisherSDK("ftp://example.com"));
    assert.throws(() => createOperonPublisherSDK("https://user:pass@example.com"));
  });

  it("accepts options-object form", () => {
    const sdk = createOperonPublisherSDK({ url: "https://api.example.com", apiKey: "k" });
    assert.ok(typeof sdk.requestPlacement === "function");
  });

  it("returns filled decision with sanitized placement and auction data", async () => {
    const sdk = createOperonPublisherSDK("https://api.example.com", "test-key");
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = {
        url,
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      };
      return new Response(
        JSON.stringify({
          decision: "filled",
          reason: "matched",
          placement: {
            sponsored: true,
            service: "cool-svc",
            serviceType: "api",
            category: "defi",
            description: "A cool service",
            routable: true,
            endpoint: "https://cool-svc.example.com",
            scoutScore: 80,
            rank: 1,
            bidPrice: 2.5,
          },
          auction: {
            candidates: 5,
            eligible: 3,
            winner: "cool-svc",
            ranking: [
              { service: "cool-svc", score: 90, bid: 2.5, rank: 1, eligible: true, reason: "top" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const result = await sdk.requestPlacement(dummyContext);
    assert.equal(result.decision, "filled");
    if (result.decision === "filled") {
      assert.equal(result.placement.service, "cool-svc");
      assert.equal(result.placement.bidPrice, 2.5);
      assert.equal(result.auction.candidates, 5);
      assert.equal(result.auction.ranking.length, 1);
    }
    // Verify the SDK forwarded the query and category through to the wire body.
    assert.ok(captured, "expected fetch to be called");
    const body = (captured as unknown as { body: { impressionContext: { requestContext: { query: string; category: string } }; placement_context: string } }).body;
    assert.equal(body.impressionContext.requestContext.query, "hello");
    assert.equal(body.impressionContext.requestContext.category, "defi");
    assert.equal(body.placement_context, "hello");
  });

  it("returns blocked decision", async () => {
    const sdk = createOperonPublisherSDK("https://api.example.com", "test-key");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ decision: "blocked", reason: "no match" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await sdk.requestPlacement(dummyContext);
    assert.equal(result.decision, "blocked");
    if (result.decision === "blocked") {
      assert.equal(result.reason, "no match");
    }
  });

  it("propagates HTTP errors thrown by the SDK", async () => {
    const sdk = createOperonPublisherSDK("https://api.example.com", "test-key");
    globalThis.fetch = async () =>
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });

    await assert.rejects(
      () => sdk.requestPlacement(dummyContext),
      (err: Error) => {
        assert.match(err.message, /500/);
        return true;
      }
    );
  });

  it("throws on unknown decision value", async () => {
    const sdk = createOperonPublisherSDK("https://api.example.com", "test-key");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ decision: "unknown-thing", reason: "wat" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    await assert.rejects(
      () => sdk.requestPlacement(dummyContext),
      (err: Error) => {
        assert.match(err.message, /unknown decision/i);
        return true;
      }
    );
  });

  it("propagates network failure from the SDK", async () => {
    const sdk = createOperonPublisherSDK("https://api.example.com", "test-key");
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await assert.rejects(
      () => sdk.requestPlacement(dummyContext),
      (err: Error) => {
        assert.equal(err.message, "fetch failed");
        return true;
      }
    );
  });

  it("works without apiKey (sandbox lane)", async () => {
    const sdk = createOperonPublisherSDK({ url: "https://api.example.com" });
    let capturedHeaders: Record<string, string> | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ decision: "blocked", reason: "no match" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await sdk.requestPlacement(dummyContext);
    assert.ok(capturedHeaders, "expected fetch to be called");
    assert.ok(!("Authorization" in (capturedHeaders as Record<string, string>)), "sandbox lane must not send Authorization header");
  });
});
