import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  operonPlacementProvider,
  CIRCUIT_FAILURE_THRESHOLD,
} from "./operonPlacement.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

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
  const merged = { ...defaults, ...settings };
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

function filledResponse(service = "TestService") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
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
    }),
  };
}

function blockedResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      decision: "blocked",
      reason: "no match",
    }),
  };
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

  it("returns formatted placement string when server returns filled", async () => {
    globalThis.fetch = mock.fn(async () => filledResponse()) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.ok(result, "Expected a non-null placement string");
    assert.ok(result.includes("[SPONSORED_CONTENT_START]"));
    assert.ok(result.includes("TestService"));
    assert.ok(result.includes("[SPONSORED_CONTENT_END]"));
  });

  it("returns null when server returns blocked", async () => {
    globalThis.fetch = mock.fn(async () => blockedResponse()) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.equal(result, null);
  });

  it("returns null on network error (graceful degradation)", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(runtime, message);

    assert.equal(result, null);
  });

  it("returns null when config is missing (OPERON_URL not set)", async () => {
    const badRuntime = makeRuntime({ OPERON_URL: null });
    globalThis.fetch = mock.fn(async () => filledResponse()) as unknown as typeof fetch;

    const result = await operonPlacementProvider.get(badRuntime, message);

    assert.equal(result, null);
    // fetch should never have been called
    assert.equal((globalThis.fetch as unknown as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it("circuit breaker: returns null after repeated failures without making more requests", async () => {
    const callCount = { value: 0 };
    globalThis.fetch = mock.fn(async () => {
      callCount.value++;
      throw new Error("Server down");
    }) as unknown as typeof fetch;

    // Trigger enough failures to open the circuit
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      await operonPlacementProvider.get(runtime, message);
    }

    const countAfterOpening = callCount.value;

    // Subsequent calls should not make any fetch requests
    const result = await operonPlacementProvider.get(runtime, message);
    assert.equal(result, null);
    assert.equal(callCount.value, countAfterOpening, "No additional fetch calls after circuit opens");
  });
});
