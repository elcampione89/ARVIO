"use client";
import { useTranslation } from "@/lib/i18n";


import { BadgeCheck, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { config } from "@/lib/config";
import {
  cachedEntitlement,
  fetchEntitlement,
  type EntitlementState
} from "@/lib/entitlement";
import { authClient, useApp } from "@/lib/store";
import { capturePremiumAttribution, trackPremiumEvent, trackPremiumMilestone, TRIAL_INTENT_KEY } from "@/lib/premiumAnalytics";
import { currentEntitlement, entitlementCheckDelay } from "@/lib/entitlementPolicy";
import { EntitlementContext } from "@/lib/entitlementContext";
import { ENTITLEMENT_REFRESH_EVENT } from "@/lib/entitlement";
import { MembershipCheckout } from "./MembershipCheckout";
import { WebFeaturePreview } from "./WebFeaturePreview";

// A still-valid cached membership survives transient backend errors. Unknown
// access is retryable, not a free membership or a request to pay again.
export function EntitlementGate({ children }: { children: React.ReactNode }) {
  const translateUi = useTranslation();
  const { auth, signOut, goToLogin } = useApp();
  const accountId = auth?.userId ?? null;
  const [state, setState] = useState<EntitlementState | null>(() => cachedEntitlement(authClient));
  const [status, setStatus] = useState<"loading" | "ready" | "error">(state ? "ready" : "loading");
  const [retry, setRetry] = useState(0);
  const [stateAccountId, setStateAccountId] = useState(accountId);
  const lastVerifiedAt = useRef(Date.now());
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    if (!config.paywallEnabled) return;
    const cached = cachedEntitlement(authClient);
    setStateAccountId(accountId);
    setState(cached);
    if (!accountId) {
      setStatus("ready");
      return;
    }
    setStatus(cached ? "ready" : "loading");
    let active = true;
    void fetchEntitlement(authClient)
      .then((next) => { if (active) { lastVerifiedAt.current = Date.now(); setState(next); setStatus("ready"); } })
      .catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [accountId, retry]);

  useEffect(() => {
    if (!config.paywallEnabled || !accountId) return;
    let active = true;
    let refreshing = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    const refreshAccess = (scheduleRetry = false) => {
      if (!active || refreshing || document.visibilityState === "hidden") return;
      if (scheduleRetry && Date.now() - lastRefreshAt.current < 1000) return;
      refreshing = true;
      lastRefreshAt.current = Date.now();
      let refreshedState = state;
      let failed = false;
      void fetchEntitlement(authClient)
        .then((next) => {
          if (!active) return;
          lastVerifiedAt.current = Date.now();
          refreshedState = next;
          setState(next);
          setStatus("ready");
          if ((!next.entitled || next.reason === "trial") && scheduleRetry) {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => refreshAccess(false), 3000);
          }
        })
        .catch(() => { failed = true; if (active) setStatus("error"); })
        .finally(() => {
          refreshing = false;
          if (active) {
            if (expiryTimer) clearTimeout(expiryTimer);
            const nextDelay = failed ? 15 * 60_000 : entitlementCheckDelay(refreshedState);
            if (nextDelay !== null) expiryTimer = setTimeout(() => refreshAccess(false), nextDelay);
          }
        });
    };

    const delay = entitlementCheckDelay(state);
    if (delay !== null) expiryTimer = setTimeout(() => refreshAccess(false), delay);

    const onFocus = () => refreshAccess(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshAccess(true);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(ENTITLEMENT_REFRESH_EVENT, onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ENTITLEMENT_REFRESH_EVENT, onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accountId, state?.entitled, state?.reason, state?.expiresAt, retry]);

  if (!config.paywallEnabled) return <>{children}</>;
  const access = stateAccountId === accountId ? currentEntitlement(state) : null;
  if (access?.entitled && (status !== "error" || Date.now() - lastVerifiedAt.current < 6 * 60 * 60_000)) return <EntitlementContext.Provider value={access}>{children}</EntitlementContext.Provider>;
  if (status === "loading" || stateAccountId !== accountId) {
    return (
      <main className="paywall-boot">
        <Loader2 className="paywall-spinner" size={40} />
      </main>
    );
  }
  if (status === "error") {
    return (
      <main className="paywall">
        <div className="paywall-card" role="alert">
          <h1>{translateUi("We could not check your membership")}</h1>
          <p className="paywall-sub">{translateUi("Your payment status has not changed. Please retry before subscribing again.")}</p>
          <button className="paywall-trial" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={16} /> {translateUi(" Check access again")}</button>
          <button className="paywall-link-toggle" onClick={goToLogin}>{translateUi("Reconnect to Cloud")}</button>
        </div>
      </main>
    );
  }

  return (
    <PaywallScreen
      state={access}
      accountId={accountId}
      isSignedIn={Boolean(auth)}
      onEntitled={(next) => {
        if (authClient.session?.userId !== accountId) return;
        lastVerifiedAt.current = Date.now(); setStateAccountId(accountId); setState(next); setStatus("ready");
      }}
      onConnect={goToLogin}
      onSignOut={signOut}
    />
  );
}

export function PaywallScreen({
  state,
  accountId,
  isSignedIn,
  onEntitled,
  onConnect,
  onSignOut
}: {
  state: EntitlementState | null;
  accountId: string | null;
  isSignedIn: boolean;
  onEntitled: (next: EntitlementState) => void;
  onConnect: () => void;
  onSignOut: () => void;
}) {
  const translateUi = useTranslation();
  const expired = state?.source !== "trial" && (state?.reason === "expired" || state?.status === "cancelled");

  useEffect(() => {
    capturePremiumAttribution();
    // Old bookmarks and stored intents must never create a free entitlement.
    try { localStorage.removeItem(TRIAL_INTENT_KEY); } catch { /* storage is optional */ }
    if (!isSignedIn) return;
    void trackPremiumEvent(authClient, "paywall_view", { flow_version: "paid_only_v1" }, true);
    void trackPremiumMilestone(authClient, "account_connected");
  }, [isSignedIn, accountId]);

  return (
    <WebFeaturePreview isSignedIn={isSignedIn} expired={expired} onConnect={onConnect} onSignOut={onSignOut} checkout={
        <MembershipCheckout
          className="paywall-primary"
          entry="feature_preview"
          onEntitled={onEntitled}
          showEmailHint
        >
          <BadgeCheck size={18} /> {isSignedIn ? translateUi("Subscribe on Ko-fi") : translateUi("Connect & get Premium")}<ExternalLink size={15} />
        </MembershipCheckout>
    } />
  );
}
