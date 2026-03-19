import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCircuit,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS,
} from "./operonPlacement.js";

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

  it("opens after reaching the failure threshold", () => {
    const circuit = getCircuit(runtime);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordFailure(circuit);
    }
    assert.equal(circuit.failures, CIRCUIT_FAILURE_THRESHOLD);
    assert.equal(isCircuitOpen(circuit), true);
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
