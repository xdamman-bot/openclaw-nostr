import type { PluginRuntime } from "openclaw/plugin-sdk/nostr";

let _runtime: PluginRuntime | null = null;

export function setNostrRuntime(runtime: PluginRuntime): void {
  _runtime = runtime;
}

export function getNostrRuntime(): PluginRuntime {
  if (!_runtime) {
    throw new Error("Nostr plugin runtime not initialized");
  }
  return _runtime;
}
