# @operon/plugin-publisher-sdk

ElizaOS plugin for [Operon](https://operon.so) - the protocol-level monetization layer for AI agents. Add quality-weighted sponsored placements to your agent's responses with zero prompt engineering.

## How it works

The plugin runs a Provider that fires on every message. It sends the conversation context to Operon's placement API, which runs a quality-weighted auction across registered advertisers. If a relevant, trustworthy service matches:

- The sponsored recommendation is injected into your agent's context
- Your agent naturally incorporates it into the response
- The placement is logged as an impression

If nothing matches, the agent responds normally. No degradation, no empty ad slots.

## Install

```bash
npx @elizaos/cli plugins add @operon/plugin-publisher-sdk
```

Or manually:

```bash
npm install @operon/plugin-publisher-sdk
```

## Configure

Set your environment variables:

```bash
OPERON_URL=https://api.operon.so    # Operon network endpoint
OPERON_API_KEY=your-publisher-key   # Your publisher API key from Operon
```

### TypeScript character

```typescript
import operonPublisherPlugin from "@operon/plugin-publisher-sdk";

export const character: Character = {
  name: "MyResearchAgent",
  plugins: [operonPublisherPlugin],
  settings: {
    secrets: {
      OPERON_URL: process.env.OPERON_URL,
      OPERON_API_KEY: process.env.OPERON_API_KEY,
    },
  },
  // ...
};
```

### JSON character

```json
{
  "name": "MyResearchAgent",
  "plugins": ["@operon/plugin-publisher-sdk"],
  "settings": {
    "secrets": {
      "OPERON_URL": "https://api.operon.so",
      "OPERON_API_KEY": "your-publisher-key"
    }
  }
}
```

## What your users see

When a sponsored placement fills:

> **[Sponsored]** Relevant service available: Jupiter Aggregator
> - Best-rate DEX aggregation across Solana
> - Trust score: 82/100

When nothing matches, the response is clean - no mention of Operon or sponsorship.

## Standalone SDK

If you want to use the Operon SDK outside ElizaOS:

```typescript
import { createOperonPublisherSDK } from "@operon/plugin-publisher-sdk";

const sdk = createOperonPublisherSDK("https://api.operon.so", "your-key");
const result = await sdk.requestPlacement({
  publisher: "my-agent",
  slotType: "agent-response",
  requestContext: {
    query: "best way to swap ETH to USDC",
    category: "defi",
    asset: "ETH",
    amount: "5",
    intent: "swap",
  },
  responseContext: {
    actions: ["swap", "compare"],
    sentiment: "neutral",
  },
});
```

## Reference agent

See [operon-otaku](https://github.com/operonhq/operon-otaku) for a complete example of an ElizaOS agent with the Operon plugin integrated.

## Links

- [operon.so](https://operon.so)
- [Documentation](https://operon.so/docs)
- [X](https://x.com/operon_so)
