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
    // Entries with empty service (null, 42, "bad") are filtered out
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
// requestPlacement() HTTP client tests
// ---------------------------------------------------------------------------

describe("requestPlacement", () => {
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

  const sdk = createOperonPublisherSDK("https://api.example.com", "test-key");

  it("returns filled decision with valid placement and auction data", async () => {
    globalThis.fetch = async () =>
      new Response(
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

    const result = await sdk.requestPlacement(dummyContext);
    assert.equal(result.decision, "filled");
    if (result.decision === "filled") {
      assert.equal(result.placement.service, "cool-svc");
      assert.equal(result.placement.bidPrice, 2.5);
      assert.equal(result.auction.candidates, 5);
      assert.equal(result.auction.ranking.length, 1);
    }
  });

  it("returns blocked decision", async () => {
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

  it("throws on HTTP error response", async () => {
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

  it("throws on invalid JSON response", async () => {
    globalThis.fetch = async () =>
      new Response("this is not json", { status: 200, headers: { "Content-Type": "text/plain" } });

    await assert.rejects(() => sdk.requestPlacement(dummyContext));
  });

  it("throws on unknown decision value", async () => {
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

  it("throws on missing decision field", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ reason: "no decision here" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    await assert.rejects(
      () => sdk.requestPlacement(dummyContext),
      (err: Error) => {
        assert.match(err.message, /missing decision/i);
        return true;
      }
    );
  });

  it("throws on network/fetch failure", async () => {
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
});
