# MD-Baileys Upstream Patch

This patch ports critical fixes and new systems from upstream Baileys v7 into **MD-Baileys**.

> **MD-Baileys** is maintained by [Tennor-modz](https://github.com/Tennor-modz) — a modified fork of WhiskeySockets/Baileys built for multi-device WhatsApp bots with extended features and stability improvements.

---

## 📦 Installation

### Install from npm (recommended)

```bash
npm install @trashcore/baileys
```

```bash
yarn add @trashcore/baileys
```

Then import in your project:

```js
// CommonJS
const { makeWASocket } = require('@trashcore/baileys')

// ESM
import { makeWASocket } from '@trashcore/baileys'
```

---

### Install as a drop-in replacement for @whiskeysockets/baileys

If your existing bot already imports from `@whiskeysockets/baileys` and you don't want to change every import statement, you can alias MD-Baileys to replace it.

**Option 1 — package.json alias (recommended)**

Add this to your bot's `package.json`:

```json
"dependencies": {
    "@whiskeysockets/baileys": "npm:@trashcore/baileys@latest"
}
```

Then run:

```bash
npm install
```

All your existing `require('@whiskeysockets/baileys')` imports will now resolve to MD-Baileys with no code changes needed.

**Option 2 — Install directly from GitHub**

```bash
npm install github:Tennor-modz/MD-Baileys
```

```bash
yarn add github:Tennor-modz/MD-Baileys
```

Then import using the GitHub package name:

```js
const { makeWASocket } = require('@trashcore/baileys')
```

---

## 🐛 Bugs Fixed by This Patch

### 1. Bad MAC Retry Loops (most impactful)
**Symptom:** Messages fail to decrypt, triggering infinite retry receipts that never resolve. The bot gets stuck in a loop sending/receiving retry stanzas with the same contact forever.

**Root cause:** The fork used a plain `Map` (`msgRetryCache`) with no intelligence about *why* decryption failed. MAC errors (Signal error codes `4` and `7`) mean the session is definitively out of sync — retrying the same broken session is pointless.

**Fix (`message-retry-manager.js`):** Replaces the plain Map with a full `MessageRetryManager` class that:
- Identifies MAC errors via the `RetryReason` enum (`SignalErrorInvalidMessage = 4`, `SignalErrorBadMac = 7`)
- Forces **immediate session recreation** on MAC errors, bypassing the normal 1-hour cooldown
- Tracks retry counts per message with LRU expiry (15-min TTL)
- Caches recently sent messages (512 msgs, 5-min TTL) for retry receipt handling
- Prevents session recreation hammering with a 1-hour cooldown for non-MAC errors
- Supports phone-based resend fallback with cancellable timeouts

---

### 2. Permanent Bad MAC After Contact Re-registers WhatsApp
**Symptom:** After a contact uninstalls and reinstalls WhatsApp (new Signal identity), every message from them permanently fails to decrypt with Bad MAC. Clearing the session manually is the only fix.

**Root cause:** WhatsApp sends a `notification type="encrypt"` stanza when a contact's identity key changes. The fork ignored this notification entirely, so the old broken session was never replaced.

**Fix (`identity-change-handler.js`):** Adds `handleIdentityChange()` which:
- Listens for identity change push notifications
- Debounces rapid identity changes per JID to avoid redundant re-keying
- Skips companion devices (only primary device identity matters)
- Skips self-identity changes
- Calls `assertSessions()` with `force=true` to tear down and rebuild the Signal session
- Supports a `onBeforeSessionRefresh` hook for tctoken re-issuance before re-keying
- Skips session refresh during offline backlog processing (handled separately)

---

### 3. Pre-key Race Conditions (intermittent Bad MAC)
**Symptom:** Intermittent decryption failures, especially under high message load or when multiple messages arrive simultaneously from the same contact.

**Root cause:** Two concurrent decryption operations could both attempt to consume the same one-time pre-key from the Signal key store simultaneously. Whichever wrote back last would corrupt the other's decryption state.

**Fix (`pre-key-manager.js`):** Adds `PreKeyManager` which:
- Creates a separate `PQueue` (concurrency: 1) per key type (`preKey`, `signedPreKey`, etc.)
- Serialises all reads and writes for each key type, eliminating the race
- Validates deletions — skips deleting a key that doesn't exist
- Inside transactions: validates against the transaction cache
- Outside transactions: validates against the live store before deleting

---

### 4. Node.js Event Loop Blocking on Reconnect
**Symptom:** After a disconnection with a large message backlog, the bot becomes unresponsive for several seconds on reconnect. Messages or ACKs may be dropped due to timeout.

**Root cause:** The fork processed all offline stanzas synchronously in a tight loop on reconnect, starving the event loop.

**Fix (`offline-node-processor.js`):** Adds `makeOfflineNodeProcessor()` which:
- Queues offline stanzas and processes them sequentially
- Yields to the event loop every 10 nodes to stay responsive
- Catches per-node errors without crashing the whole processing loop
- Stops processing if the WebSocket closes mid-batch

---

### 5. Incorrect ACK Stanza Construction
**Symptom:** Some ACKs sent by the fork were missing the `from` field on message-class stanzas, which WA Web always includes. Can cause server-side ACK routing issues.

**Fix (`stanza-ack.js`):** Adds `buildAckStanza()` — a pure function that:
- Always includes `from = meId` for `message`-class ACKs (matching WA Web behaviour)
- Correctly forwards `participant`, `recipient`, and `type` attributes when present
- Supports NACK (error ACK) via optional `errorCode` parameter

---

### 6. LID-Addressed Messages Always Fail to Decrypt
**Symptom:** Messages from contacts whose JID has migrated to LID format (Linked ID) silently fail to decrypt. No error is thrown — the message just never arrives.

**Root cause:** The fork had no LID ↔ Phone Number mapping system. Signal sessions are keyed to a JID — when WA addresses a message to a LID JID but the session is stored under the PN JID, the session lookup finds nothing and decryption fails.

**Fix (`lid-mapping.js`):** Adds `LIDMappingStore` which:
- Maintains a bidirectional LID ↔ PN mapping persisted via `keys.set('lid-mapping', ...)`
- LRU in-memory cache (3-day TTL) to avoid redundant DB lookups
- In-flight request deduplication — multiple concurrent lookups for the same JID coalesce into one
- Falls back to USync (WA's contact sync) when a mapping isn't cached or stored
- `getLIDForPN(pn)` / `getPNForLID(lid)` / `storeLIDPNMappings(pairs)` API

---

### 7. Error 463 on Some 1-to-1 Message Sends
**Symptom:** Occasionally sending a message to a contact returns a `463` error from WA servers. The message is never delivered.

**Root cause:** WhatsApp's privacy token (`tctoken`) system requires a token to be attached to outgoing 1-to-1 messages. The fork had no tctoken system at all.

**Fix (`tc-token-utils.js`):** Adds the full tctoken system:
- `buildTcTokenFromJid()` — reads stored token and attaches it to outgoing message content
- `storeTcTokensFromIqResult()` — persists received tokens from IQ results
- `resolveTcTokenJid()` — resolves PN JIDs to LID for storage (WA stores tokens under LID)
- `isTcTokenExpired()` — 28-day rolling bucket expiry check
- `shouldSendNewTcToken()` — deduplicates token issuance within the same 7-day bucket
- Token index management for cross-session pruning (`TC_TOKEN_INDEX_KEY`)

---

## ✨ New Exports Added

### `lib/WABinary/jid-utils.js` (replaces existing)
Fully backward-compatible replacement — all old exports preserved, new ones added:

| Export | What it does |
|---|---|
| `isPnUser(jid)` | Alias for `isJidUser` — checks `@s.whatsapp.net` |
| `isHostedPnUser(jid)` | Checks `@hosted` server |
| `isHostedLidUser(jid)` | Checks `@hosted.lid` server |
| `isJidMetaAI(jid)` | Checks `@bot` server (Meta AI) |
| `isJidBot(jid)` | Checks bot phone number pattern (`1313555xxxx`) |
| `isJidNewsletter(jid)` | Fixed spelling (was `isJidNewsLetter`, old name kept as alias) |
| `getServerFromDomainType(server, domainType)` | Maps `WAJIDDomains` enum → server string |
| `transferDevice(fromJid, toJid)` | Copies device ID from one JID to another |
| `WAJIDDomains` | Enum: `WHATSAPP=0, LID=1, HOSTED=128, HOSTED_LID=129` |
| `META_AI_JID` | Constant: `'13135550002@c.us'` |
| Full `domainType` in `jidDecode()` | Now correctly sets `HOSTED` and `HOSTED_LID` domain types (fork only handled `LID=1` or `0`) |

### `lib/Utils/index.js` (replaces existing)
Updated barrel file — re-exports all 6 new Utils modules in addition to all existing ones. No existing exports removed.

---

## 📁 Patch File Placement

```
your-md-baileys-repo/
├── lib/
│   ├── Utils/
│   │   ├── index.js                    ← REPLACE existing
│   │   ├── message-retry-manager.js    ← NEW
│   │   ├── identity-change-handler.js  ← NEW
│   │   ├── pre-key-manager.js          ← NEW
│   │   ├── offline-node-processor.js   ← NEW
│   │   ├── stanza-ack.js               ← NEW
│   │   └── tc-token-utils.js           ← NEW
│   ├── Signal/
│   │   └── lid-mapping.js              ← NEW
│   └── WABinary/
│       └── jid-utils.js                ← REPLACE existing
```

---

## 🔧 New npm Dependencies Required

After placing the files, install the two new dependencies:

```bash
npm install lru-cache p-queue
```

```bash
yarn add lru-cache p-queue
```

- `lru-cache` — used by `MessageRetryManager` and `LIDMappingStore`
- `p-queue` — used by `PreKeyManager` for per-keyType serialisation

> `lru-cache` may already be in your `package.json` — check before installing.

---

## ⚠️ Integration Note

These files are self-contained and will load without errors. However, to fully activate the fixes, the socket layer must be updated to *call* them:

- **`messages-recv.js`** — instantiate `MessageRetryManager` instead of the plain Map; call `handleIdentityChange` on `notification type="encrypt"`; wrap offline stanza processing with `makeOfflineNodeProcessor`; use `buildAckStanza` for ACK construction
- **`messages-send.js`** — attach tctoken on 1-to-1 sends via `buildTcTokenFromJid`; use `LIDMappingStore` for LID-priority session selection
- **`auth-utils.js`** — use `PreKeyManager` inside `addTransactionCapability` for pre-key operations

Without those call-site changes, the new modules are importable but dormant.

---

## 🔗 Links

- **Repository:** https://github.com/Tennor-modz/MD-Baileys
- **Issues:** https://github.com/Tennor-modz/MD-Baileys/issues
- **Upstream (WhiskeySockets/Baileys):** https://github.com/WhiskeySockets/Baileys
