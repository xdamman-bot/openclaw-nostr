import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  createScopedDmSecurityResolver,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createPreCryptoDirectDmAuthorizer,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  dispatchInboundDirectDmWithRuntime,
  formatPairingApproveHint,
  resolveInboundDirectDmAccessWithRuntime,
  nostrSetupAdapter,
  nostrSetupWizard,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/nostr";
import { NostrConfigSchema } from "./config-schema.js";
import {
  normalizePubkey,
  startNostrMultiBus,
  validatePrivateKey,
  type NostrMultiBusHandle,
} from "./nostr-bus.js";
import { getNostrRuntime } from "./runtime.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";

// ============================================================================
// Shared bus state
// ============================================================================

let sharedBus: NostrMultiBusHandle | null = null;
let sharedBusAccountCount = 0;

// ============================================================================
// Helpers
// ============================================================================

function normalizeNostrAllowEntry(entry: string): string | "*" | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  try {
    return normalizePubkey(trimmed.replace(/^nostr:/i, ""));
  } catch {
    return null;
  }
}

function isNostrSenderAllowed(senderPubkey: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizePubkey(senderPubkey);
  for (const entry of allowFrom) {
    const normalized = normalizeNostrAllowEntry(entry);
    if (normalized === "*") return true;
    if (normalized === normalizedSender) return true;
  }
  return false;
}

async function resolveNostrDirectAccess(params: {
  cfg: Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]["cfg"];
  accountId: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: Array<string | number> | undefined;
  senderPubkey: string;
  rawBody: string;
  runtime: Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]["runtime"];
}) {
  return resolveInboundDirectDmAccessWithRuntime({
    cfg: params.cfg,
    channel: "nostr",
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowFrom,
    senderId: params.senderPubkey,
    rawBody: params.rawBody,
    isSenderAllowed: isNostrSenderAllowed,
    runtime: params.runtime,
    modeWhenAccessGroupsOff: "configured",
  });
}

// ============================================================================
// DM Policy Resolver
// ============================================================================

const resolveNostrDmPolicy = createScopedDmSecurityResolver<ResolvedNostrAccount>({
  channelKey: "nostr",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: formatPairingApproveHint("nostr"),
  normalizeEntry: (raw) => {
    try {
      return normalizePubkey(raw.trim().replace(/^nostr:/i, ""));
    } catch {
      return raw.trim();
    }
  },
});

// ============================================================================
// Config Adapter (multi-account)
// ============================================================================

const nostrConfigAdapter = createScopedChannelConfigAdapter<ResolvedNostrAccount>({
  sectionKey: "nostr",
  listAccountIds: listNostrAccountIds,
  resolveAccount: (cfg, accountId) => resolveNostrAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultNostrAccountId,
  clearBaseFields: [
    "name",
    "defaultAccount",
    "privateKey",
    "relays",
    "dmPolicy",
    "allowFrom",
    "profile",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => {
        if (entry === "*") return "*";
        try {
          return normalizePubkey(entry);
        } catch {
          return entry;
        }
      })
      .filter(Boolean),
});

// ============================================================================
// Outbound session route
// ============================================================================

import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/core";

function resolveNostrOutboundSessionRoute(params: {
  cfg: Parameters<typeof buildChannelOutboundSessionRoute>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { to: string; kind: string; display?: string; source: string };
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  const to = params.resolvedTarget?.to ?? params.target;
  const normalizedTo = normalizePubkey(to);
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    peer: { kind: "direct", id: normalizedTo },
    chatType: "direct",
    from: "nostr",
    to: normalizedTo,
  });
}

// ============================================================================
// Channel Plugin
// ============================================================================

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = createChatChannelPlugin({
  base: {
    id: "nostr",
    meta: {
      id: "nostr",
      label: "Nostr",
      selectionLabel: "Nostr (multi-account DMs)",
      docsPath: "/channels/nostr",
      docsLabel: "nostr",
      blurb: "Decentralized DMs via Nostr relays (NIP-04) with multi-account support",
      order: 55,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
    },
    reload: { configPrefixes: ["channels.nostr"] },
    configSchema: buildChannelConfigSchema(NostrConfigSchema),
    setup: nostrSetupAdapter,
    setupWizard: nostrSetupWizard,
    config: {
      ...nostrConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
          },
        }),
    },
    messaging: {
      normalizeTarget: (target) => {
        const cleaned = target.trim().replace(/^nostr:/i, "");
        try {
          return normalizePubkey(cleaned);
        } catch {
          return cleaned;
        }
      },
      targetResolver: {
        looksLikeId: (input) => {
          const trimmed = input.trim();
          return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
        },
        hint: "<npub|hex pubkey|nostr:npub...>",
      },
      resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params),
    },
    status: {
      ...createComputedAccountStatusAdapter<ResolvedNostrAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveChannelStatusSummary(snapshot, {
            publicKey: (snapshot as Record<string, unknown>).publicKey ?? null,
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
            profile: account.profile,
            ...buildTrafficStatusSummary(runtime),
          },
        }),
      }),
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        ctx.setStatus({
          accountId: account.accountId,
          publicKey: account.publicKey,
        });
        ctx.log?.info(
          `[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`,
        );

        if (!account.configured) {
          throw new Error("Nostr private key not configured");
        }

        const runtime = getNostrRuntime();

        // If the shared bus already exists, this account is already covered.
        // The first account to start creates the bus for ALL accounts.
        if (sharedBus) {
          sharedBusAccountCount++;
          ctx.log?.info(
            `[${account.accountId}] Joined shared Nostr multi-bus (${sharedBusAccountCount} accounts)`,
          );
          return {
            stop: () => {
              sharedBusAccountCount--;
              ctx.log?.info(`[${account.accountId}] Left shared Nostr multi-bus`);
              if (sharedBusAccountCount <= 0 && sharedBus) {
                sharedBus.close();
                sharedBus = null;
                sharedBusAccountCount = 0;
                ctx.log?.info("Shared Nostr multi-bus closed");
              }
            },
          };
        }

        // Collect ALL configured accounts and start ONE shared bus
        const allAccountIds = listNostrAccountIds(ctx.cfg);
        const allAccounts = allAccountIds
          .map((id) => {
            const resolved = resolveNostrAccount({ cfg: ctx.cfg, accountId: id });
            if (!resolved.configured || !resolved.enabled) return null;
            try {
              return {
                accountId: id,
                privateKeyHex: validatePrivateKey(resolved.privateKey),
                publicKeyHex: resolved.publicKey,
                relays: resolved.relays,
              };
            } catch (err) {
              ctx.log?.warn?.(`[${id}] Invalid private key, skipping: ${String(err)}`);
              return null;
            }
          })
          .filter((a): a is NonNullable<typeof a> => a !== null);

        if (allAccounts.length === 0) {
          throw new Error("No valid Nostr accounts configured");
        }

        ctx.log?.info(
          `Starting shared Nostr multi-bus for ${allAccounts.length} account(s): ${allAccounts.map((a) => a.accountId).join(", ")}`,
        );

        // Build per-account pairing controllers and access resolvers
        const pairingControllers = new Map<string, ReturnType<typeof createChannelPairingController>>();
        for (const acc of allAccounts) {
          pairingControllers.set(
            acc.accountId,
            createChannelPairingController({
              core: runtime,
              channel: "nostr",
              accountId: acc.accountId,
            }),
          );
        }

        const bus = await startNostrMultiBus({
          accounts: allAccounts,
          authorizeSender: async ({ accountId, senderPubkey, reply }) => {
            const resolved = resolveNostrAccount({ cfg: ctx.cfg, accountId });
            const resolvedAccess = await resolveNostrDirectAccess({
              cfg: ctx.cfg,
              accountId,
              dmPolicy: resolved.config.dmPolicy ?? "pairing",
              allowFrom: resolved.config.allowFrom,
              senderPubkey,
              rawBody: "",
              runtime: {
                shouldComputeCommandAuthorized:
                  runtime.channel.commands.shouldComputeCommandAuthorized,
                resolveCommandAuthorizedFromAuthorizers:
                  runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
              },
            });

            const authorizer = createPreCryptoDirectDmAuthorizer({
              resolveAccess: async () => resolvedAccess,
              issuePairingChallenge: async ({ senderId, reply: pairingReply }) => {
                const pairing = pairingControllers.get(accountId);
                if (pairing) {
                  await pairing.issueChallenge({
                    senderId,
                    senderIdLine: `Your Nostr pubkey: ${senderId}`,
                    sendPairingReply: pairingReply,
                    onCreated: () => {
                      ctx.log?.debug?.(
                        `[${accountId}] nostr pairing request sender=${senderId}`,
                      );
                    },
                    onReplyError: (err) => {
                      ctx.log?.warn?.(
                        `[${accountId}] nostr pairing reply failed for ${senderId}: ${String(err)}`,
                      );
                    },
                  });
                }
              },
              onBlocked: ({ senderId, reason }) => {
                ctx.log?.debug?.(
                  `[${accountId}] blocked Nostr sender ${senderId} (${reason})`,
                );
              },
            });

            return authorizer({ senderId: senderPubkey, reply });
          },
          onMessage: async (accountId, senderPubkey, plaintext, reply, meta) => {
            const resolved = resolveNostrAccount({ cfg: ctx.cfg, accountId });

            // Double-check access after decryption
            const resolvedAccess = await resolveNostrDirectAccess({
              cfg: ctx.cfg,
              accountId,
              dmPolicy: resolved.config.dmPolicy ?? "pairing",
              allowFrom: resolved.config.allowFrom,
              senderPubkey,
              rawBody: plaintext,
              runtime: {
                shouldComputeCommandAuthorized:
                  runtime.channel.commands.shouldComputeCommandAuthorized,
                resolveCommandAuthorizedFromAuthorizers:
                  runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
              },
            });

            if (resolvedAccess.access.decision !== "allow") {
              ctx.log?.warn?.(
                `[${accountId}] dropping Nostr DM after preflight drift (${senderPubkey}, ${resolvedAccess.access.reason})`,
              );
              return;
            }

            await dispatchInboundDirectDmWithRuntime({
              cfg: ctx.cfg,
              runtime,
              channel: "nostr",
              channelLabel: "Nostr",
              accountId,
              peer: {
                kind: "direct",
                id: senderPubkey,
              },
              senderId: senderPubkey,
              senderAddress: `nostr:${senderPubkey}`,
              recipientAddress: `nostr:${resolved.publicKey}`,
              conversationLabel: senderPubkey,
              rawBody: plaintext,
              messageId: meta.eventId,
              timestamp: meta.createdAt * 1000,
              commandAuthorized: resolvedAccess.commandAuthorized,
              deliver: async (payload) => {
                const outboundText =
                  payload && typeof payload === "object" && "text" in payload
                    ? String((payload as { text?: string }).text ?? "")
                    : "";
                if (!outboundText.trim()) return;
                const tableMode = runtime.channel.text.resolveMarkdownTableMode({
                  cfg: ctx.cfg,
                  channel: "nostr",
                  accountId,
                });
                await reply(
                  runtime.channel.text.convertMarkdownTables(outboundText, tableMode),
                );
              },
              onRecordError: (err) => {
                ctx.log?.error?.(
                  `[${accountId}] failed recording Nostr inbound session: ${String(err)}`,
                );
              },
              onDispatchError: (err, info) => {
                ctx.log?.error?.(
                  `[${accountId}] Nostr ${info.kind} reply failed: ${String(err)}`,
                );
              },
            });
          },
          onError: (error, context) => {
            ctx.log?.error?.(`Nostr multi-bus error (${context}): ${error.message}`);
          },
          onConnect: (relay) => {
            ctx.log?.debug?.(`Connected to relay: ${relay}`);
          },
          onDisconnect: (relay) => {
            ctx.log?.debug?.(`Disconnected from relay: ${relay}`);
          },
          onEose: (relay) => {
            ctx.log?.debug?.(`EOSE received from relays: ${relay}`);
          },
        });

        sharedBus = bus;
        sharedBusAccountCount = 1;

        ctx.log?.info(
          `Shared Nostr multi-bus started, listening on ${allAccounts.length} pubkeys across ${new Set(allAccounts.flatMap((a) => a.relays)).size} relay(s)`,
        );

        return {
          stop: () => {
            sharedBusAccountCount--;
            if (sharedBusAccountCount <= 0 && sharedBus) {
              sharedBus.close();
              sharedBus = null;
              sharedBusAccountCount = 0;
              ctx.log?.info("Shared Nostr multi-bus closed");
            }
          },
        };
      },
    },
  },
  pairing: {
    text: {
      idLabel: "nostrPubkey",
      message: "Your pairing request has been approved!",
      normalizeAllowEntry: (entry) => {
        try {
          return normalizePubkey(entry.trim().replace(/^nostr:/i, ""));
        } catch {
          return entry.trim();
        }
      },
      notify: async ({ id, message }) => {
        if (sharedBus) {
          // Send from the default account
          await sharedBus.sendDm(DEFAULT_ACCOUNT_ID, id, message);
        }
      },
    },
  },
  security: {
    resolveDmPolicy: resolveNostrDmPolicy,
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const core = getNostrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      if (!sharedBus) {
        throw new Error(`Nostr bus not running`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "nostr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to);
      await sharedBus.sendDm(aid, normalizedTo, message);
      return attachChannelToResult("nostr", {
        to: normalizedTo,
        messageId: `nostr-${Date.now()}`,
      });
    },
  },
});
