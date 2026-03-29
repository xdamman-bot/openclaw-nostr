import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import {
  listCombinedAccountIds,
  resolveListedDefaultAccountId,
} from "openclaw/plugin-sdk/account-resolution";
import { listBoundAccountIds } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/nostr";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate } from "./nostr-bus.js";

export { DEFAULT_ACCOUNT_ID };

export interface NostrAccountConfig {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  privateKey?: string;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: NostrProfile;
}

export interface ResolvedNostrAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: NostrProfile;
  config: NostrAccountConfig;
}

function getNostrChannelConfig(cfg: OpenClawConfig): NostrAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;
}

function getNostrAccountsRecord(cfg: OpenClawConfig): Record<string, NostrAccountConfig> | undefined {
  const nostrCfg = getNostrChannelConfig(cfg) as (NostrAccountConfig & { accounts?: Record<string, NostrAccountConfig> }) | undefined;
  return nostrCfg?.accounts;
}

function resolveConfiguredDefaultNostrAccountId(cfg: OpenClawConfig): string | undefined {
  const nostrCfg = getNostrChannelConfig(cfg);
  return normalizeOptionalAccountId(nostrCfg?.defaultAccount);
}

/**
 * List all configured Nostr account IDs (multi-account aware)
 */
export function listNostrAccountIds(cfg: OpenClawConfig): string[] {
  const nostrCfg = getNostrChannelConfig(cfg);
  const accounts = getNostrAccountsRecord(cfg);
  const configuredIds = Object.keys(accounts ?? {}).map((k) => normalizeAccountId(k));

  return listCombinedAccountIds({
    configuredAccountIds: configuredIds,
    additionalAccountIds: listBoundAccountIds(cfg, "nostr"),
    implicitAccountId: nostrCfg?.privateKey
      ? (resolveConfiguredDefaultNostrAccountId(cfg) ?? DEFAULT_ACCOUNT_ID)
      : undefined,
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
}

/**
 * Get the default account ID
 */
export function resolveDefaultNostrAccountId(cfg: OpenClawConfig): string {
  return resolveListedDefaultAccountId({
    accountIds: listNostrAccountIds(cfg),
    configuredDefaultAccountId: resolveConfiguredDefaultNostrAccountId(cfg),
  });
}

/**
 * Resolve a Nostr account from config (multi-account aware)
 */
export function resolveNostrAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = normalizeAccountId(opts.accountId ?? resolveDefaultNostrAccountId(opts.cfg));
  const nostrCfg = getNostrChannelConfig(opts.cfg);
  const accounts = getNostrAccountsRecord(opts.cfg);

  const baseEnabled = nostrCfg?.enabled !== false;

  // Account-specific config (if multi-account)
  const accountCfg = accounts?.[accountId];

  // Merge: account-specific overrides top-level
  const privateKey = accountCfg?.privateKey
    || (accountId === DEFAULT_ACCOUNT_ID ? nostrCfg?.privateKey : "")
    || "";
  const relays = accountCfg?.relays ?? nostrCfg?.relays ?? DEFAULT_RELAYS;
  const dmPolicy = accountCfg?.dmPolicy ?? nostrCfg?.dmPolicy;
  const allowFrom = accountCfg?.allowFrom ?? nostrCfg?.allowFrom;
  const profile = accountCfg?.profile ?? nostrCfg?.profile;
  const accountEnabled = accountCfg?.enabled !== false;
  const name = accountCfg?.name?.trim() || nostrCfg?.name?.trim() || undefined;

  const configured = Boolean(privateKey.trim());

  let publicKey = "";
  if (configured) {
    try {
      publicKey = getPublicKeyFromPrivate(privateKey);
    } catch {
      // Invalid key - leave publicKey empty
    }
  }

  return {
    accountId,
    name,
    enabled: baseEnabled && accountEnabled,
    configured,
    privateKey,
    publicKey,
    relays,
    profile,
    config: {
      enabled: accountCfg?.enabled ?? nostrCfg?.enabled,
      name: name,
      privateKey,
      relays,
      dmPolicy,
      allowFrom,
      profile,
    },
  };
}
