# @operon/plugin-publisher-sdk

ElizaOS plugin for [Operon](https://operon.so) - the protocol-level monetization layer for AI agents. Add quality-weighted sponsored placements to your agent's responses with zero prompt engineering.

## How it works

The plugin runs a Provider that fires on every message. It sends the user's query to Operon's placement API, which runs a quality-weighted auction across registered advertisers. Context fields (category, asset, intent) are configurable via settings with empty defaults — the Operon server handles matching and returns `blocked` when nothing fits.

If a relevant, trustworthy service matches:

- The sponsored recommendation is injected into your agent's context
- Your agent naturally incorporates it into the response
- The placement is logged as an impression on the Operon server

If nothing matches, the agent responds normally. No degradation, no empty ad slots.

Under the hood, this plugin is a thin ElizaOS adapter on top of [`@operon/sdk`](https://www.npmjs.com/package/@operon/sdk). The SDK owns network, retries, the circuit breaker, the per-client UUID, and source attribution; this package just maps ElizaOS settings and message lifecycle into SDK calls.

## Install

```bash
npx @elizaos/cli plugins add @operon/plugin-publisher-sdk
```

Or manually:

```bash
npm install @operon/plugin-publisher-sdk
```

## Configure

Set the following environment variables (or character settings):

| Setting | Required | Description |
|---|---|---|
| `OPERON_API_URL` | yes | Operon network endpoint, e.g. `https://api.operon.so`. Legacy alias `OPERON_URL` still works. |
| `OPERON_API_KEY` | no | Publisher API key from Operon. **Omit to run in sandbox mode** — the SDK mints a stable client UUID locally and the server treats traffic as sandbox. |
| `OPERON_PUBLISHER_NAME` | no | Publisher identifier (defaults to character name). |
| `OPERON_CATEGORY` | no | Category, e.g. `defi`. Legacy alias `OPERON_DEFAULT_CATEGORY`. |
| `OPERON_INTENT` | no | Intent, e.g. `swap`. Legacy alias `OPERON_DEFAULT_INTENT`. |
| `OPERON_ASSET` | no | Asset, e.g. `ETH`. |
| `OPERON_SOURCE` | no | Marketplace/skill attribution tag (first-touch wins; see `@operon/sdk` docs). |
| `OPERON_ALLOW_HTTP` | no | Set to `"true"` to allow plain HTTP (development only). |
| `OPERON_DEBUG` | no | Set to `"true"` to log connection details. |

### TypeScript character

```typescript
import operonPublisherPlugin from "@operon/plugin-publisher-sdk";

export const character: Character = {
  name: "MyResearchAgent",
  plugins: [operonPublisherPlugin],
  settings: {
    secrets: {
      OPERON_API_URL: process.env.OPERON_API_URL,
      OPERON_API_KEY: process.env.OPERON_API_KEY, // optional
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
      "OPERON_API_URL": "https://api.operon.so",
      "OPERON_API_KEY": "your-publisher-key"
    }
  }
}
```

## Sandbox lane

If `OPERON_API_KEY` is omitted, the plugin runs in sandbox mode:

- The SDK mints a UUID at `~/.operon/client.json` on first call (override with `OPERON_CLIENT_ID` for read-only filesystems).
- Traffic is unauthenticated and is treated as sandbox by the server.
- Use this for local development before requesting a publisher key.

To register as a real publisher, install the SDK CLI and follow the prompts: `npx @operon/sdk register`.

## What your users see

When a sponsored placement fills:

> **[Sponsored]** Relevant service available: Jupiter Aggregator
> - Best-rate DEX aggregation across Solana
> - Trust score: 82/100

When nothing matches, the response is clean — no mention of Operon or sponsorship.

## Data flow

The plugin sends the following to the Operon API on every message:

- **User's message text** — forwarded as the placement query and `placement_context`
- **Publisher name** — your agent's identifier
- **Category, intent, asset** — whatever you set via settings (empty by default)
- **`X-Operon-Client` header** — stable UUID from `~/.operon/client.json` (or env override)
- **`X-Operon-Source` header** — only when `OPERON_SOURCE` is set

No wallet addresses, private keys, or credentials are extracted or sent separately, but any content in the user's message text will be included in the API request. Publishers should consider this when deciding whether to integrate the plugin.

## Reference agent

See [operon-otaku](https://github.com/operonhq/operon-otaku) for a complete example of an ElizaOS agent with the Operon plugin integrated.

## Links

- [operon.so](https://operon.so)
- [Documentation](https://operon.so/docs)
- [@operon/sdk on npm](https://www.npmjs.com/package/@operon/sdk)
- [X](https://x.com/operon_so)
