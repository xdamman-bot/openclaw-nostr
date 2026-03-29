import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { nostrPlugin } from "./channel.js";
import type { NostrProfile } from "./config-schema.js";
import { getNostrRuntime, setNostrRuntime } from "./runtime.js";
import { resolveNostrAccount } from "./types.js";

export { nostrPlugin } from "./channel.js";
export { setNostrRuntime } from "./runtime.js";

export default defineChannelPluginEntry({
  id: "nostr",
  name: "Nostr",
  description: "Nostr DM channel plugin via NIP-04 with multi-account support",
  plugin: nostrPlugin,
  setRuntime: setNostrRuntime,
  registerFull(api) {
    // HTTP handler for profile management could be added here
    // For now, keep it simple — the core multi-account DM functionality is the priority
  },
});
