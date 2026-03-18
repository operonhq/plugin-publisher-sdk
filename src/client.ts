import type { ImpressionContext, OperonPlacementResponse } from "./types.js";

export interface OperonPublisherSDK {
  requestPlacement(
    context: ImpressionContext
  ): Promise<OperonPlacementResponse>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function createOperonPublisherSDK(
  operonUrl: string,
  apiKey: string
): OperonPublisherSDK {
  const baseUrl = operonUrl.replace(/\/+$/, "");

  return {
    async requestPlacement(
      context: ImpressionContext
    ): Promise<OperonPlacementResponse> {
      const response = await fetch(`${baseUrl}/placement`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ impressionContext: context }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Operon placement request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`
        );
      }

      const data: unknown = await response.json();

      if (!data || typeof data !== "object" || !("decision" in data)) {
        throw new Error(
          "Operon returned invalid placement response: missing decision field"
        );
      }

      const obj = data as Record<string, unknown>;

      if (obj.decision === "filled") {
        if (
          !obj.placement ||
          typeof obj.placement !== "object" ||
          !("service" in (obj.placement as object))
        ) {
          throw new Error(
            "Operon returned filled decision without valid placement data"
          );
        }
        return data as OperonPlacementResponse;
      }

      if (obj.decision === "blocked") {
        return data as OperonPlacementResponse;
      }

      throw new Error(
        `Operon returned unknown decision: ${String(obj.decision)}`
      );
    },
  };
}
