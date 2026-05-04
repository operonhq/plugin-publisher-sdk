import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatPlacement } from "./operonPlacement.js";
import type { PlacementDetails } from "../types.js";

// Circuit breaker tests live in @operon/sdk's own test suite; the plugin
// no longer holds a parallel breaker implementation.

// ---------------------------------------------------------------------------
// formatPlacement
// ---------------------------------------------------------------------------

describe("formatPlacement", () => {
  const basePlacement: PlacementDetails = {
    sponsored: true,
    service: "ChangeNOW",
    serviceType: "crypto_swap",
    category: "defi",
    description: "Non-custodial swaps for 1000+ coins",
    routable: false,
    endpoint: "",
    clickUrl: null,
    scoutScore: 0,
    rank: 1,
    bidPrice: 200,
  };

  it("includes clickUrl and Markdown instruction when clickUrl is present", () => {
    const placement = { ...basePlacement, clickUrl: "https://api.operon.so/c/imp_abc123" };
    const result = formatPlacement(placement);

    assert.ok(result.includes("[SPONSORED_CONTENT_START]"));
    assert.ok(result.includes("[SPONSORED_CONTENT_END]"));
    assert.ok(result.includes("ChangeNOW"));
    assert.ok(result.includes("- Click URL: https://api.operon.so/c/imp_abc123"));
    assert.ok(result.includes("clickable Markdown link"));
    assert.ok(!result.includes("- Endpoint:"));
    assert.ok(result.includes("Trust score: 0/100"));
  });

  it("falls back to endpoint when clickUrl is null and routable", () => {
    const placement = { ...basePlacement, clickUrl: null, routable: true, endpoint: "https://example.com/api" };
    const result = formatPlacement(placement);

    assert.ok(result.includes("- Endpoint: https://example.com/api"));
    assert.ok(!result.includes("- Click URL:"));
    assert.ok(!result.includes("clickable Markdown link"));
  });

  it("includes no URL line when clickUrl is null and not routable", () => {
    const placement = { ...basePlacement, clickUrl: null, routable: false, endpoint: "" };
    const result = formatPlacement(placement);

    assert.ok(!result.includes("- Click URL:"));
    assert.ok(!result.includes("- Endpoint:"));
    assert.ok(!result.includes("clickable Markdown link"));
    assert.ok(result.includes("[SPONSORED_CONTENT_START]"));
    assert.ok(result.includes("ChangeNOW"));
    assert.ok(result.includes("[SPONSORED_CONTENT_END]"));
  });

  it("clickUrl takes priority over endpoint even when routable", () => {
    const placement = {
      ...basePlacement,
      clickUrl: "https://api.operon.so/c/imp_xyz",
      routable: true,
      endpoint: "https://example.com/api",
    };
    const result = formatPlacement(placement);

    assert.ok(result.includes("- Click URL: https://api.operon.so/c/imp_xyz"));
    assert.ok(!result.includes("- Endpoint:"));
  });

  it("omits scoutScore line when scoutScore is null", () => {
    const placement = { ...basePlacement, scoutScore: null as unknown as number };
    const result = formatPlacement(placement);
    assert.ok(!result.includes("Trust score"));
  });
});
