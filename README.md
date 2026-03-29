# @xdamman/openclaw-nostr

OpenClaw Nostr channel plugin with **multi-account support**.

## Architecture

- **ONE** `SimplePool` connection subscribes to NIP-04 DMs (kind 4) for ALL agent pubkeys
- When a DM arrives, the plugin checks which agent pubkey is the recipient, looks up that agent's nsec, decrypts, and routes to the correct agent
- Each account has its own nsec, relays, dmPolicy, and allowFrom config

## Config

```json
{
  "channels": {
    "nostr": {
      "privateKey": "nsec1...",
      "relays": ["wss://relay.damus.io", "wss://nos.lol"],
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1..."],
      "accounts": {
        "coder": {
          "privateKey": "nsec1...",
          "relays": ["wss://relay.damus.io"],
          "dmPolicy": "allowlist",
          "allowFrom": ["npub1..."]
        },
        "writer": {
          "privateKey": "nsec1...",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

## Install

```bash
openclaw plugins install --link /path/to/openclaw-nostr-plugin-v2
```

## Build

```bash
npm install
npm run build
```
