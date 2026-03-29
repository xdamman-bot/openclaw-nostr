import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip19,
  type Event,
} from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import { DEFAULT_RELAYS } from "./default-relays.js";

// ============================================================================
// Constants
// ============================================================================

const STARTUP_LOOKBACK_SEC = 120;
const SEEN_MAX_SIZE = 10_000;
const SEEN_PRUNE_KEEP = 5_000;

// ============================================================================
// Types
// ============================================================================

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
  authorizeSender?: (params: {
    accountId: string;
    senderPubkey: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<"allow" | "block" | "pairing">;
  onError?: (error: Error, context: string) => void;
  onConnect?: (relay: string) => void;
  onDisconnect?: (relay: string) => void;
  onEose?: (relay: string) => void;
}

export interface NostrMultiBusHandle {
  close: () => void;
  publicKeys: string[];
  sendDm: (accountId: string, toPubkey: string, text: string) => Promise<void>;
}

// ============================================================================
// Key Validation
// ============================================================================

export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();

  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Invalid nsec key: wrong type");
    }
    return decoded.data;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Private key must be 64 hex characters or nsec bech32 format");
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

// ============================================================================
// Pubkey Utilities
// ============================================================================

export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Invalid npub key");
    }
    return Array.from(decoded.data as unknown as Uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}

export function pubkeyToNpub(hexPubkey: string): string {
  const normalized = normalizePubkey(hexPubkey);
  return nip19.npubEncode(normalized);
}

export function isValidPubkey(input: string): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub";
    } catch {
      return false;
    }
  }
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}

// ============================================================================
// Send DM Helper
// ============================================================================

async function sendEncryptedDm(
  pool: SimplePool,
  sk: Uint8Array,
  toPubkey: string,
  text: string,
  relays: string[],
  onError?: (error: Error, context: string) => void,
): Promise<void> {
  const ciphertext = encrypt(sk, toPubkey, text);
  const reply = finalizeEvent(
    {
      kind: 4,
      content: ciphertext,
      tags: [["p", toPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  );

  let lastError: Error | undefined;
  for (const relay of relays) {
    try {
      await pool.publish([relay], reply);
      return;
    } catch (err) {
      lastError = err as Error;
      onError?.(lastError, `publish to ${relay}`);
    }
  }
  throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
}

// ============================================================================
// Multi-Account Bus
// ============================================================================

export async function startNostrMultiBus(
  options: NostrMultiBusOptions,
): Promise<NostrMultiBusHandle> {
  const pool = new SimplePool();
  const seen = new Set<string>();

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

  const relays = [...allRelays];
  const since = Math.floor(Date.now() / 1000) - STARTUP_LOOKBACK_SEC;

  // ONE subscription for ALL pubkeys
  const sub = pool.subscribeMany(
    relays,
    [{ kinds: [4], "#p": allPubkeys, since }] as unknown as Parameters<typeof pool.subscribeMany>[1],
    {
      onevent: async (event: Event) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        if (seen.size > SEEN_MAX_SIZE) {
          const arr = [...seen];
          seen.clear();
          for (const id of arr.slice(-SEEN_PRUNE_KEEP)) seen.add(id);
        }

        // Skip our own messages
        if (allPubkeys.includes(event.pubkey)) return;

        // Find which account this DM is for
        const recipientPubkey = event.tags.find((t) => t[0] === "p")?.[1];
        if (!recipientPubkey) return;

        const account = accountByPubkey.get(recipientPubkey);
        if (!account) return;

        // Verify signature
        if (!verifyEvent(event)) {
          options.onError?.(new Error("Invalid signature"), `event ${event.id}`);
          return;
        }

        // Build reply function
        const replyFn = async (text: string): Promise<void> => {
          await sendEncryptedDm(pool, account.privateKeyHex, event.pubkey, text, account.relays, options.onError);
        };

        // Authorization check (pre-crypto)
        if (options.authorizeSender) {
          const decision = await options.authorizeSender({
            accountId: account.accountId,
            senderPubkey: event.pubkey,
            reply: replyFn,
          });
          if (decision !== "allow") return;
        }

        // Decrypt
        try {
          const plaintext = await decrypt(account.privateKeyHex, event.pubkey, event.content);

          await options.onMessage(
            account.accountId,
            event.pubkey,
            plaintext,
            replyFn,
            {
              eventId: event.id,
              createdAt: event.created_at,
            },
          );
        } catch (err) {
          options.onError?.(
            err instanceof Error ? err : new Error(String(err)),
            `decrypt from ${event.pubkey} for account ${account.accountId}`,
          );
        }
      },
      oneose: () => {
        options.onEose?.(relays.join(", "));
      },
      onclose: (reason) => {
        for (const relay of relays) {
          options.onDisconnect?.(relay);
        }
        options.onError?.(
          new Error(`Subscription closed: ${String(reason)}`),
          "subscription",
        );
      },
    },
  );

  return {
    close: () => {
      sub.close();
      pool.close(relays);
    },
    publicKeys: allPubkeys,
    sendDm: async (accountId: string, toPubkey: string, text: string) => {
      const account = accountById.get(accountId);
      if (!account) {
        throw new Error(`No account found for id: ${accountId}`);
      }
      await sendEncryptedDm(pool, account.privateKeyHex, toPubkey, text, account.relays, options.onError);
    },
  };
}
