import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCircuit,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  formatPlacement,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS,
} from "./operonPlacement.js";
import type { PlacementDetails } from "../types.js";

/**
 * Minimal stub that satisfies IAgentRuntime enough for getCircuit's WeakMap key.
 * Each test gets a fresh runtime so circuits don't bleed across tests.
 */
function makeRuntime(): Parameters<typeof getCircuit>[0] {
  return {} as Parameters<typeof getCircuit>[0];
}

describe("Circuit breaker state machine", () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    runtime = makeRuntime();
  });

  it("starts in closed state", () => {
    const circuit = getCircuit(runtime);
    assert.equal(circuit.failures, 0);
    assert.equal(circuit.openUntil, 0);
    assert.equal(circuit.halfOpen, false);
    assert.equal(isCircuitOpen(circuit), false);
  });

  it("stays closed below the failure threshold", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      recordFailure(circuit);
      assert.equal(isCircuitOpen(circuit), false, `should stay closed at ${i + 1} failures`);
    }
    assert.equal(circuit.failures, CIRCUIT_FAILURE_THRESHOLD - 1);
  });

  it("opens after reaching the failure threshold", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    assert.equal(circuit.failures, CIRCUIT_FAILURE_THRESHOLD);
    assert.equal(isCircuitOpen(circuit), true);
  });

  it("increments failures one at a time", () => {
    const circuit = getCircuit(runtime);
    recordFailure(circuit);
    assert.equal(circuit.failures, 1);
    recordFailure(circuit);
    assert.equal(circuit.failures, 2);
    recordFailure(circuit);
    assert.equal(circuit.failures, 3);
  });

  it("blocks requests while open", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    assert.equal(isCircuitOpen(circuit), true);
  });

  it("transitions to half-open after cooldown and allows one probe", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    // Simulate cooldown expiry
    circuit.openUntil = Date.now() - 1;
    // First call should enter half-open and allow probe
    assert.equal(isCircuitOpen(circuit), false);
    assert.equal(circuit.halfOpen, true);
    // Second call while half-open should block (probe already in flight)
    assert.equal(isCircuitOpen(circuit), true);
  });

  it("closes on probe success", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    // Simulate cooldown expiry and half-open
    circuit.openUntil = Date.now() - 1;
    isCircuitOpen(circuit); // triggers half-open
    assert.equal(circuit.halfOpen, true);

    recordSuccess(circuit);
    assert.equal(circuit.failures, 0);
    assert.equal(circuit.halfOpen, false);
    assert.equal(circuit.openUntil, 0);
    assert.equal(isCircuitOpen(circuit), false);
  });

  it("re-opens on probe failure", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    // Simulate cooldown expiry and half-open
    circuit.openUntil = Date.now() - 1;
    isCircuitOpen(circuit); // triggers half-open

    recordFailure(circuit);
    assert.equal(circuit.halfOpen, false);
    assert.ok(circuit.openUntil > Date.now() - 1000);
    assert.equal(isCircuitOpen(circuit), true);
  });

  it("does not re-extend openUntil on concurrent failures after threshold", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    const firstOpenUntil = circuit.openUntil;
    // Additional failures should not extend the cooldown
    recordFailure(circuit);
    assert.equal(circuit.openUntil, firstOpenUntil);
    // Failures should be capped at threshold
    assert.equal(circuit.failures, CIRCUIT_FAILURE_THRESHOLD);
  });
});

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
    assert.ok(result.includes("Click URL above so the user can click it"));
    // Should NOT include endpoint when clickUrl is present
    assert.ok(!result.includes("- Endpoint:"));
    // scoutScore: 0 should still emit trust score line (!= null guard, not falsy check)
    assert.ok(result.includes("Trust score: 0/100"));
  });

  it("falls back to endpoint when clickUrl is null and routable", () => {
    const placement = { ...basePlacement, clickUrl: null, routable: true, endpoint: "https://example.com/api" };
    const result = formatPlacement(placement);

    assert.ok(result.includes("- Endpoint: https://example.com/api"));
    assert.ok(!result.includes("- Click URL:"));
    assert.ok(!result.includes("Click URL above so the user can click it"));
  });

  it("includes no URL line when clickUrl is null and not routable", () => {
    const placement = { ...basePlacement, clickUrl: null, routable: false, endpoint: "" };
    const result = formatPlacement(placement);

    assert.ok(!result.includes("- Click URL:"));
    assert.ok(!result.includes("- Endpoint:"));
    assert.ok(!result.includes("Click URL above so the user can click it"));
    // Should still have the basic structure
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
