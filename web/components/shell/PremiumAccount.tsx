"use client";
import { useTranslation } from "@/lib/i18n";


import { BadgeCheck, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { useEntitlement } from "@/lib/entitlementContext";
import { ENTITLEMENT_REFRESH_EVENT, type EntitlementState } from "@/lib/entitlement";
import { config } from "@/lib/config";
import { MembershipCheckout } from "./MembershipCheckout";

export function PremiumAccount() {
  const translateUi = useTranslation();
  const { auth } = useApp();
  const entitlement = useEntitlement();
  const [state, setState] = useState(entitlement);
  const [message, setMessage] = useState("");
  useEffect(() => { setState(entitlement); setMessage(""); }, [auth?.userId, entitlement]);
  if (!config.paywallEnabled || !auth) return null;
  const paid = state?.entitled && state.reason === "subscription";
  const applied = (next: EntitlementState) => {
    if (!next.entitled || next.reason !== "subscription" || next.source === "trial") return;
    setState(next);
    setMessage("Your Premium membership is active.");
    window.dispatchEvent(new Event(ENTITLEMENT_REFRESH_EVENT));
  };
  return <section className="premium-account" aria-labelledby="premium-account-title">
    <h2 id="premium-account-title"><BadgeCheck size={20} /> {translateUi(" ARVIO Web Premium")}</h2>
    <p className="premium-account-status">{paid ? translateUi("Membership active") : translateUi("Check membership")}</p>
    <p className="premium-account-email">{auth.email}</p>
    {state?.expiresAt && <p>{translateUi("Access until")}: {new Date(state.expiresAt).toLocaleString()}</p>}
    <p>{translateUi("Browser access on iPhone, iPad, Windows, Mac and Linux. The Android app and Cloud dashboard remain free.")}</p>
    <div className="premium-account-actions">
      {!paid && <MembershipCheckout className="paywall-primary" entry="account_settings" onEntitled={applied} showEmailHint>
        {translateUi("Keep Premium - $2.99/month ")}<ExternalLink size={15} />
      </MembershipCheckout>}
    </div>
    {message && <p role="status">{translateUi(message)}</p>}
  </section>;
}
