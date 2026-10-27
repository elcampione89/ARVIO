// Web subscription entitlements. Stored in a dedicated Netlify Blobs store,
// keyed by sha256(email) so the Ko-fi webhook (which only knows the buyer's
// email, not an ARVIO access token) and the app (which has a JWT identity with
// an email) resolve the SAME record. The APK never reads this — web only.
//
// An entitlement record:
//   {
//     status: "active" | "expired" | "cancelled",
//     source: "kofi" | "manual" | "trial",
//     tier: string | null,
//     startedAt: ISO string,
//     expiresAt: ISO string | null,   // null = lifetime
//     trialUsed: boolean,             // retained historical trial marker
//     lastEvent: string | null,
//     updatedAt: ISO string
//   }
const { connectLambda, getStore } = require("@netlify/blobs");

// Hosted Web is paid-only. These legacy response fields stay explicit so old
// clients cannot interpret a missing value as an available three-day trial.
const TRIAL_DAYS = 0;
const TRIAL_MS = 0;

function entitlementsStore(event) {
  connectLambda(event);
  return getStore("entitlements");
}

function entitlementKey(emailHash) {
  return `email/${emailHash}.json`;
}

async function readEntitlement(store, emailHash) {
  try {
    return await store.get(entitlementKey(emailHash), { type: "json", consistency: "strong" });
  } catch (error) {
    if (String(error?.message || "").includes("uncachedEdgeURL")) {
      return store.get(entitlementKey(emailHash), { type: "json" });
    }
    if (error?.status === 404 || error?.name === "BlobNotFoundError") return null;
    throw error;
  }
}

async function writeEntitlement(store, emailHash, record) {
  await store.setJSON(entitlementKey(emailHash), record);
  return record;
}

// The single source of truth the app reads: is this account entitled to web
// access right now, and why. Never throws — a storage hiccup returns "unknown"
// so the caller can decide (we fail-closed on the paywall, open on errors only
// with an explicit grace, see the check function in the web app).
function evaluateEntitlement(record) {
  const now = Date.now();
  if (!record) {
    return { entitled: false, reason: "none", status: "none", trialAvailable: false, trialDurationDays: TRIAL_DAYS, expiresAt: null, source: null };
  }
  const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : null;
  // Keep legacy trial records for account history, but never let one unlock
  // hosted Web, including a trial whose old deadline is still in the future.
  const historicalTrial = record.source === "trial";
  const active = !historicalTrial &&
    record.status === "active" && (expiresAt === null || expiresAt > now);
  return {
    entitled: active,
    reason: active ? "subscription" : historicalTrial ? "none" : "expired",
    status: historicalTrial ? "expired" : record.status || "none",
    source: record.source || null,
    tier: record.tier || null,
    expiresAt: record.expiresAt || null,
    trialAvailable: false,
    trialDurationDays: TRIAL_DAYS,
    updatedAt: record.updatedAt || null
  };
}

// Grant/renew a paid subscription for `days` from now (or lifetime when days is
// null). Merges onto any existing record so a trial->paid upgrade keeps history.
function buildPaidRecord(existing, { source, tier, days, event }) {
  const now = new Date();
  const expiresAt = days == null ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  return {
    ...(existing || {}),
    status: "active",
    source: source || "kofi",
    tier: tier || (existing && existing.tier) || null,
    startedAt: (existing && existing.startedAt) || now.toISOString(),
    expiresAt,
    trialUsed: existing ? existing.trialUsed === true : false,
    lastEvent: event || null,
    updatedAt: now.toISOString()
  };
}

module.exports = {
  TRIAL_MS,
  TRIAL_DAYS,
  entitlementsStore,
  readEntitlement,
  writeEntitlement,
  evaluateEntitlement,
  buildPaidRecord
};
