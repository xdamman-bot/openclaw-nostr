import {
  Relay,
  finalizeEvent,
  getPublicKey,
  nip19,
  type Event,
} from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import { DEFAULT_RELAYS } from "./default-relays.js";

const STARTUP_LOOKBACK_SEC = 120;
const SEEN_MAX_SIZE = 10_000;
const SEEN_PRUNE_KEEP = 5_000;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 10 * 60 * 1000; // 10 minutes

export interface AccountInfo {
  accountId: string;
  privateKeyHex: Uint8Array;
  publicKeyHex: string;
  relays: string[];
}

export interface NostrMultiBusOptions {
  accounts: AccountInfo[];
  onMessage: (
    accountId: string,
    senderPubkey: string,
    plaintext: string,
    reply: (text: string) => Promise<void>,
    meta: { eventId: string; createdAt: number },
  ) => Promise<void>;
  authorizeInbound?: (accountId: string, senderPubkey: string) => Promise<boolean | string>;
  onError?: (error: Error, context: string) => void;
  onConnect?: (relay: string) => void;
  onDisconnect?: (relay: string) => void;
  log?: {
    info: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

export interface NostrMultiBusHandle {
  close: () => void;
  publicKeys: string[];
  sendDm: (accountId: string, toPubkey: string, text: string) => Promise<void>;
  sendTypingIndicator: (accountId: string, toPubkey: string) => Promise<void>;
  startTypingLoop: (accountId: string, toPubkey: string) => void;
  stopTypingLoop: (accountId: string, toPubkey: string) => void;
}

export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("Invalid nsec key");
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Private key must be 64 hex chars or nsec format");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function getPublicKeyFromPrivate(privateKey: string): string {
  const sk = validatePrivateKey(privateKey);
  return getPublicKey(sk);
}

export function normalizePubkey(input: string): string {
  const trimmed = input.trim().replace(/^nostr:/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "npub") return decoded.data;
  }
  throw new Error(`Cannot normalize pubkey: ${input}`);
}

export async function startNostrMultiBus(
  options: NostrMultiBusOptions,
): Promise<NostrMultiBusHandle> {
  const seen = new Set<string>();
  const log: { info: (m:string)=>void; warn?: (m:string)=>void; error?: (m:string)=>void; debug?: (m:string)=>void } = options.log ?? { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  let stopped = false;

  // Build lookup maps
  const accountByPubkey = new Map<string, AccountInfo>();
  const accountById = new Map<string, AccountInfo>();
  const allPubkeys: string[] = [];
  const allRelays = new Set<string>();

  for (const account of options.accounts) {
    accountByPubkey.set(account.publicKeyHex, account);
    accountById.set(account.accountId, account);
    allPubkeys.push(account.publicKeyHex);
    for (const r of account.relays) allRelays.add(r);
  }

  const relayUrls = [...allRelays];
  const since = Math.floor(Date.now() / 1000) - STARTUP_LOOKBACK_SEC;
  const activeRelays: Relay[] = [];
  const reconnectAttempts = new Map<string, number>();

  async function handleEvent(event: Event) {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > SEEN_MAX_SIZE) {
      const arr = [...seen];
      seen.clear();
      for (const id of arr.slice(-SEEN_PRUNE_KEEP)) seen.add(id);
    }

    // Find recipient account
    const recipientPubkey = event.tags.find((t) => t[0] === "p")?.[1];
    if (!recipientPubkey) return;
    const account = accountByPubkey.get(recipientPubkey);
    if (!account) return;

    // Skip self-messages (same account sending to itself), but allow
    // inter-agent DMs (agent A sending to agent B on the same bus)
    if (event.pubkey === recipientPubkey) return;

    // Authorize
    if (options.authorizeInbound) {
      const result = await options.authorizeInbound(account.accountId, event.pubkey); const allowed = result === true || result === "allow";
      if (!allowed) return;
    }

    // Decrypt
    try {
      const plaintext = await decrypt(account.privateKeyHex, event.pubkey, event.content);

      const reply = async (text: string) => {
        const ciphertext = await encrypt(account.privateKeyHex, event.pubkey, text);
        const replyEvent = finalizeEvent(
          {
            kind: 4,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["p", event.pubkey]],
            content: ciphertext,
          },
          account.privateKeyHex,
        );
        // Publish to all connected relays
        const promises = activeRelays.map((r) => r.publish(replyEvent).catch(() => {}));
        await Promise.allSettled(promises);
      };

      await options.onMessage(account.accountId, event.pubkey, plaintext, reply, {
        eventId: event.id,
        createdAt: event.created_at,
      });
    } catch (err) {
      options.onError?.(
        err instanceof Error ? err : new Error(String(err)),
        `decrypt for account ${account.accountId}`,
      );
    }
  }

  async function connectRelay(url: string) {
    if (stopped) return;
    try {
      const relay = await Relay.connect(url);
      activeRelays.push(relay);
      reconnectAttempts.set(url, 0); // Reset on success
      log.info(`[nostr-bus] Connected to ${url} (${activeRelays.length} relay(s) active)`);
      options.onConnect?.(url);

      // Subscribe to DMs for all pubkeys
      relay.subscribe(
        [{ kinds: [4], "#p": allPubkeys, since }],
        {
          onevent: handleEvent,
          oneose: () => log.debug?.(`[nostr-bus] EOSE from ${url}`),
        },
      );

      // Handle disconnection
      relay.onclose = () => {
        if (stopped) return;
        const idx = activeRelays.indexOf(relay);
        if (idx >= 0) activeRelays.splice(idx, 1);
        log.warn?.(`[nostr-bus] Disconnected from ${url} (${activeRelays.length} relay(s) still active)`);
        options.onDisconnect?.(url);
        scheduleReconnect(url);
      };
    } catch (err) {
      log.warn?.(`[nostr-bus] Failed to connect to ${url}: ${err}`);
      scheduleReconnect(url);
    }
  }

  function scheduleReconnect(url: string) {
    if (stopped) return;
    const attempts = (reconnectAttempts.get(url) ?? 0) + 1;
    reconnectAttempts.set(url, attempts);
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s, 320s, 600s (cap)
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts - 1), RECONNECT_MAX_DELAY_MS);
    log.info(`[nostr-bus] Reconnecting to ${url} in ${Math.round(delay / 1000)}s (attempt ${attempts})`);
    setTimeout(() => connectRelay(url), delay);
  }

  // Send DM from a specific account
  async function sendDm(accountId: string, toPubkey: string, text: string) {
    const account = accountById.get(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const ciphertext = await encrypt(account.privateKeyHex, toPubkey, text);
    const event = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", toPubkey]],
        content: ciphertext,
      },
      account.privateKeyHex,
    );
    const promises = activeRelays.map((r) => r.publish(event).catch(() => {}));
    await Promise.allSettled(promises);
  }

  // Send ephemeral typing indicator (kind 20003) from a specific account.
  // Kind 20003 is in the ephemeral range (20000-29999) per NIP-01 —
  // relays MUST NOT store it, only forward to connected subscribers.
  async function sendTypingIndicator(accountId: string, toPubkey: string) {
    const account = accountById.get(accountId);
    if (!account) return; // silently skip if account not found
    const event = finalizeEvent(
      {
        kind: 20003,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", toPubkey]],
        content: "",
      },
      account.privateKeyHex,
    );
    // Fire-and-forget to all connected relays
    const promises = activeRelays.map((r) => r.publish(event).catch(() => {}));
    await Promise.allSettled(promises);
  }

  // Typing loop state: one loop per (accountId, toPubkey) pair
  const typingLoops = new Map<string, NodeJS.Timeout>();

  function typingLoopKey(accountId: string, toPubkey: string) {
    return `${accountId}:${toPubkey}`;
  }

  // Start sending typing indicators every 5s until stopTypingLoop is called.
  // Sends one immediately, then repeats every 5s.
  function startTypingLoop(accountId: string, toPubkey: string) {
    const key = typingLoopKey(accountId, toPubkey);
    // If already running, don't duplicate
    if (typingLoops.has(key)) return;
    // Send immediately
    sendTypingIndicator(accountId, toPubkey).catch(() => {});
    // Then every 5s
    const interval = setInterval(() => {
      sendTypingIndicator(accountId, toPubkey).catch(() => {});
    }, 5_000);
    typingLoops.set(key, interval);
  }

  // Stop the typing loop for a given conversation.
  function stopTypingLoop(accountId: string, toPubkey: string) {
    const key = typingLoopKey(accountId, toPubkey);
    const interval = typingLoops.get(key);
    if (interval) {
      clearInterval(interval);
      typingLoops.delete(key);
    }
  }

  // Connect to all relays — failures are handled by scheduleReconnect,
  // so the bus always starts even if no relay is initially reachable.
  await Promise.allSettled(relayUrls.map((url) => connectRelay(url)));

  if (activeRelays.length === 0) {
    log.warn?.(`[nostr-bus] No relays connected on startup — will keep retrying in background`);
  } else {
    log.info(`[nostr-bus] Started with ${activeRelays.length}/${relayUrls.length} relay(s) connected`);
  }

  return {
    close: () => {
      stopped = true;
      for (const r of activeRelays) {
        try { r.close(); } catch {}
      }
      activeRelays.length = 0;
    },
    publicKeys: allPubkeys,
    sendDm,
    sendTypingIndicator,
    startTypingLoop,
    stopTypingLoop,
  };
}
