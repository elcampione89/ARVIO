"use client";
import { useTranslation } from "@/lib/i18n";


import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { hasNetlifyBackendConfig, hasSupabaseConfig, getAuthPortalUrl } from "@/lib/config";
import { capturePremiumAttribution, TRIAL_INTENT_KEY } from "@/lib/premiumAnalytics";
import { useApp } from "@/lib/store";
import { partnerLoginRedirect } from "@/lib/partnerLinks";
import { config } from "@/lib/config";
import { fetchPanelPortals, selectedPanelServer, setSelectedPanelServer, type PanelPortal } from "@/lib/panel";

export function LoginScreen() {
  return config.panelMode ? <PanelLoginScreen /> : <CloudLoginScreen />;
}

/** Panel mode: sign in with the same line (username + password) as the TV app. */
function PanelLoginScreen() {
  const translateUi = useTranslation();
  const { signIn, toast } = useApp();
  const [portals, setPortals] = useState<PanelPortal[] | null>(null);
  const [serverId, setServerId] = useState<number | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPanelPortals()
      .then((list) => {
        if (cancelled) return;
        setPortals(list);
        const saved = selectedPanelServer();
        setServerId(list.some((p) => p.id === saved) ? saved : list[0]?.id ?? null);
      })
      .catch((e: unknown) => { if (!cancelled) { setPortals([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { cancelled = true; };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) { setError(translateUi("Enter your username and password.")); return; }
    setError("");
    setBusy(true);
    setSelectedPanelServer(serverId);
    try {
      await signIn(username.trim(), password, "sign-in");
    } catch (e) {
      setError(e instanceof Error ? e.message : translateUi("Sign in failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <div className="login-hero">
        <div className="login-copy">
          <div className="login-brand-lockup">
            <img src="/arvio-logo.svg" alt="" className="login-brand-logo" />
            <img src="/arvio-wordmark.svg" alt="ARVIO" className="login-wordmark" />
          </div>
          <p className="login-tag">{translateUi("Sign in")}</p>
          <p className="login-sub">{translateUi("Use the same username and password as your TV app. Your profiles, Continue Watching and live TV follow you between the TV and this browser.")}</p>
        </div>
        <form className="login-card login-form" onSubmit={submit}>
          <p className="login-card-title">{translateUi("Sign in to continue")}</p>
          {portals && portals.length > 1 && (
            <select value={serverId ?? ""} onChange={(e) => setServerId(Number(e.target.value) || null)} aria-label={translateUi("Service")}>
              {portals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={translateUi("Username")} autoComplete="username" autoCapitalize="none" spellCheck={false} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={translateUi("Password")} type="password" autoComplete="current-password" />
          {error ? <p className="login-error">{error}</p> : toast ? <p className="login-sub">{toast}</p> : null}
          <button type="submit" className="primary login-submit" disabled={busy || portals === null}>
            {busy ? translateUi("Signing in") : translateUi("Sign in")}
          </button>
        </form>
      </div>
    </main>
  );
}

function CloudLoginScreen() {
  const translateUi = useTranslation();
  const { backToProfiles, cloudLoginRequired } = useApp();
  const cloudConfigured = hasNetlifyBackendConfig() || hasSupabaseConfig();
  const [mounted, setMounted] = useState(false);

  const redirectToAuthPortal = () => {
    if (typeof window === "undefined") return;
    const redirectUri = partnerLoginRedirect(window.location.origin, window.location.search);
    const portalUrl = getAuthPortalUrl();
    window.location.href = `${portalUrl}?redirect_uri=${encodeURIComponent(redirectUri)}`;
  };

  useEffect(() => {
    capturePremiumAttribution();
    if (new URLSearchParams(window.location.search).get("intent") === "trial") {
      try { localStorage.setItem(TRIAL_INTENT_KEY, "1"); } catch { /* storage is optional */ }
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && cloudConfigured) {
      const hash = window.location.hash || "";
      if (!hash.includes("access_token=")) {
        redirectToAuthPortal();
      }
    }
  }, [mounted, cloudConfigured]);

  return (
    <main className="login-shell">
      {!cloudLoginRequired && (
        <button type="button" className="login-back" onClick={backToProfiles} aria-label={translateUi("Back")}><ArrowLeft size={20} /> {translateUi(" Back")}</button>
      )}
      <div className="login-hero">
        <div className="login-copy">
          <div className="login-brand-lockup">
            <img src="/arvio-logo.svg" alt="" className="login-brand-logo" />
            <img src="/arvio-wordmark.svg" alt="ARVIO" className="login-wordmark" />
          </div>
          <p className="login-tag">{translateUi("Cloud sign-in required")}</p>
          <p className="login-sub">{translateUi("Use your ARVIO Cloud account to sync profiles, continue watching, Trakt activity, addons, catalogs, and playback settings across devices.")}</p>
          <div className="login-proof">
            <span>{translateUi("Profiles")}</span>
            <span>{translateUi("Watch history")}</span>
            <span>{translateUi("Addons")}</span>
            <span>{translateUi("Trakt sync")}</span>
          </div>
        </div>

        <div className="login-card">
          <p className="login-card-title">{translateUi("Sign in to continue")}</p>
          {!cloudConfigured && <p className="login-error">{translateUi("ARVIO Cloud backend env is missing. Add values in web/.env.local.")}</p>}
          <button type="button" className="primary login-submit" onClick={redirectToAuthPortal} disabled={!cloudConfigured}>
            {translateUi("Sign In with ARVIO Cloud")}</button>
        </div>
      </div>
    </main>
  );
}
