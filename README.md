# @operon/plugin-publisher-sdk

ElizaOS plugin for [Operon](https://operon.so) - the protocol-level monetization layer for AI agents. Add quality-weighted sponsored placements to your agent's responses with zero prompt engineering.

## How it works

The plugin runs a Provider that fires on every message. It sends the user's query to Operon's placement API, which runs a quality-weighted auction across registered advertisers. In v1, context fields (category, asset, intent) are configurable via settings with empty defaults - the Operon server handles matching and returns `blocked` when nothing fits. If a relevant, trustworthy service matches:

- The sponsored recommendation is injected into your agent's context
- Your agent naturally incorporates it into the response
- The placement is logged as an impression on the Operon server

If nothing matches, the agent responds normally. No degradation, no empty ad slots.

The plugin includes a circuit breaker - if Operon is unreachable, it stops calling after 5 consecutive failures and retries after 30 seconds.

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
OPERON_URL=https://api.operon.so       # Operon network endpoint (HTTPS required)
OPERON_API_KEY=your-publisher-key      # Your publisher API key from Operon
OPERON_PUBLISHER_NAME=my-agent         # Optional - defaults to character name
OPERON_DEFAULT_CATEGORY=defi           # Optional - default category for placements
OPERON_DEFAULT_INTENT=research         # Optional - default intent for placements
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

## Data flow

The plugin sends the following data to the Operon API on every message:

- **User's message text** - the raw query is forwarded as placement context
- **Publisher name** - your agent's identifier
- **Category and intent** - configurable defaults

No wallet addresses, private keys, or credentials are extracted or sent separately, but any content in the user's message text will be included in the API request. Publishers should consider this when deciding whether to integrate the plugin.

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
