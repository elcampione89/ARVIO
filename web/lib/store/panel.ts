// App store (lib/store.tsx): Panel mode (NEXT_PUBLIC_PANEL_MODE). The ARVIO panel supplies each
// line's addons, collection packs and live TV service, and decides whether the line may still watch.
// Every hook here is a no-op outside panel mode.
import { useEffect, useRef } from "react";
import { installAddon as installAddonManifest } from "../addons";
import { config } from "../config";
import { mergeImportedCollections, parseCustomCollections } from "../customCollections";
import { withPanelPlaylist } from "../panel";
import type { CatalogConfig, InstalledAddon } from "../types";
import { authClient } from "./clients";
import type { StoreCore } from "./core";
import type { useAddonActions } from "./addons";
import type { useUpdateSettings } from "./settingsSync";

type PanelStore = StoreCore
  & Pick<ReturnType<typeof useAddonActions>, "persistAddons">
  & Pick<ReturnType<typeof useUpdateSettings>, "updateSettings">;

export function usePanelSync(store: PanelStore) {
  const {
    auth, setAuth, addonsReady, cloudProfilesHydrated, setCloudProfilesHydrated, activeProfileId, activeProfileIdRef,
    personalAddonsRef, persistAddons, settings, setSettings, settingsRef, updateSettings, setView, setToast
  } = store;

  // Install the addons the panel gives this line, and remove ones the panel dropped,
  // in each profile once per visit (the TV app does the same on every device).
  const panelAddonsSyncedRef = useRef<string>("");
  useEffect(() => {
    if (!config.panelMode || !auth || !addonsReady || !cloudProfilesHydrated || !activeProfileId) return;
    const key = `${auth.userId}:${activeProfileId}`;
    if (panelAddonsSyncedRef.current === key) return;
    panelAddonsSyncedRef.current = key;
    const match = (url: string) => url.trim().toLowerCase().replace(/\/manifest\.json$/, "").replace(/\/+$/, "");
    void (async () => {
      try {
        const response = await fetch("/api/panel/addons", { headers: { Authorization: `Bearer ${auth.accessToken}` }, cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { addons?: Array<{ url?: string }>; removed_urls?: string[] };
        const current = personalAddonsRef.current;
        const have = new Set(current.map((addon) => match(addon.manifestUrl)));
        const removed = new Set((data.removed_urls ?? []).map(match));
        const added: InstalledAddon[] = [];
        for (const item of data.addons ?? []) {
          if (!item.url || have.has(match(item.url))) continue;
          try { added.push(await installAddonManifest(item.url)); } catch { /* addon offline; try next visit */ }
        }
        const dropped = current.filter((addon) => removed.has(match(addon.manifestUrl)));
        if (!added.length && !dropped.length) return;
        if (activeProfileIdRef.current !== activeProfileId) return;
        const latest = personalAddonsRef.current;
        const next = [...added, ...latest.filter((addon) => !dropped.some((d) => d.id === addon.id) && !added.some((a) => a.id === addon.id))];
        await persistAddons(next, { addedIds: added.map((a) => a.id), removedIds: dropped.map((d) => d.id) });
      } catch {
        panelAddonsSyncedRef.current = "";
      }
    })();
  }, [auth, addonsReady, cloudProfilesHydrated, activeProfileId, persistAddons]);

  // The panel's collection packs on every profile's home screen. Same pack IDs as the
  // TV app ("arvio-panel://collections/N"), so packs synced from a TV are updated, not duplicated.
  const panelCollectionsSyncedRef = useRef<string>("");
  useEffect(() => {
    if (!config.panelMode || !auth || !cloudProfilesHydrated || !activeProfileId) return;
    const key = `${auth.userId}:${activeProfileId}`;
    if (panelCollectionsSyncedRef.current === key) return;
    panelCollectionsSyncedRef.current = key;
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    void (async () => {
      try {
        const response = await fetch("/api/panel/collections", { headers, cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { collections?: Array<{ id?: number; name?: string | null }>; removed_ids?: number[] };
        const packUrl = (id: number) => `arvio-panel://collections/${id}`;
        const imported: CatalogConfig[][] = [];
        for (const pack of data.collections ?? []) {
          if (!pack.id) continue;
          try {
            const res = await fetch(`/api/panel/collection?id=${pack.id}`, { headers, cache: "no-store" });
            if (!res.ok) continue;
            const parsed = await parseCustomCollections(await res.text(), packUrl(pack.id));
            const name = pack.name?.trim();
            imported.push(name && parsed[0]?.packName === "collections" ? parsed.map((c) => ({ ...c, packName: name })) : parsed);
          } catch { /* skip a broken pack */ }
        }
        const removedPackIds = new Set<string>();
        for (const id of data.removed_ids ?? []) {
          // Same pack ID the importer would give it.
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(packUrl(id))));
          removedPackIds.add(`usercol_${Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("")}`);
        }
        if (activeProfileIdRef.current !== activeProfileId) return;
        const current = settingsRef.current.catalogs;
        let next = current.filter((c) => !c.packId || !removedPackIds.has(c.packId));
        for (const pack of imported) next = mergeImportedCollections(next, pack);
        if (JSON.stringify(next) !== JSON.stringify(current)) updateSettings({ catalogs: next });
      } catch {
        panelCollectionsSyncedRef.current = "";
      }
    })();
  }, [auth, cloudProfilesHydrated, activeProfileId, updateSettings]);

  // Live TV is always the signed-in line's own TV service.
  useEffect(() => {
    if (!config.panelMode || !auth) return;
    const wanted = withPanelPlaylist(settings.iptvPlaylists);
    if (JSON.stringify(wanted) !== JSON.stringify(settings.iptvPlaylists)) {
      setSettings((current) => ({ ...current, iptvPlaylists: withPanelPlaylist(current.iptvPlaylists) }));
    }
  }, [auth, settings.iptvPlaylists]);

  // The panel decides whether this line may still watch (expiry, disabled, device signed out
  // from the panel). Check on start and when the tab comes back, at most every 10 min.
  useEffect(() => {
    if (!config.panelMode) return;
    let lastCheck = 0;
    const check = async () => {
      const token = authClient.session?.accessToken;
      if (!token || Date.now() - lastCheck < 10 * 60_000) return;
      lastCheck = Date.now();
      try {
        const response = await fetch("/api/panel/me", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (response.status === 401 || response.status === 403) {
          let message = "Your session has ended. Please sign in again.";
          try { message = ((await response.json()) as { message?: string }).message || message; } catch { /* keep default */ }
          if (authClient.session?.accessToken !== token) return;
          authClient.signOut();
          setAuth(null);
          setCloudProfilesHydrated(true);
          setView("login");
          setToast(message);
        }
      } catch {
        // Offline or panel unreachable: keep watching.
      }
    };
    void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [auth]);
}
