import { config } from "./config";
import { normalizeIptvInput, normalizeEpgInputs } from "./iptv";
import { loadStored, removeStored, saveStored } from "./storage";
import type { IptvPlaylistEntry } from "./types";

/**
 * Panel mode helpers (NEXT_PUBLIC_PANEL_MODE=true). The web app signs in with an ARVIO panel
 * line, like the Android app: the line's TV service becomes the live TV source, and the panel's
 * addons and collections are installed for every profile. Requests go through this server's
 * /api/panel routes, so the panel's address is never sent to the browser.
 */

export const PANEL_PLAYLIST_ID = "panel_login";
const LINE_KEY = "arvio.web.panel.line";
const DEVICE_KEY = "arvio.web.panel.device";
const SERVER_KEY = "arvio.web.panel.server";

export interface PanelPortal {
  id: number;
  name: string;
}

export interface PanelLine {
  username: string;
  password: string;
  serverUrl: string;
  displayName: string;
  userId: string;
}

export function panelDeviceId(): string {
  let id = loadStored<string | null>(DEVICE_KEY, null);
  if (!id) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    id = "web-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    saveStored(DEVICE_KEY, id);
  }
  return id;
}

export function panelDeviceName(): string {
  if (typeof navigator === "undefined") return "Web browser";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "Mac"
    : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return `Web: ${browser}${os ? " on " + os : ""}`;
}

export function selectedPanelServer(): number | null {
  return loadStored<number | null>(SERVER_KEY, null);
}

export function setSelectedPanelServer(id: number | null) {
  if (id) saveStored(SERVER_KEY, id);
  else removeStored(SERVER_KEY);
}

export function panelLine(): PanelLine | null {
  if (!config.panelMode) return null;
  const line = loadStored<PanelLine | null>(LINE_KEY, null);
  return line && line.serverUrl && line.username ? line : null;
}

export function savePanelLine(line: PanelLine) {
  saveStored(LINE_KEY, line);
}

export function clearPanelLine() {
  removeStored(LINE_KEY);
}

/** The signed-in line's TV service as an IPTV playlist (same shape as the Android app's). */
export function panelPlaylist(): IptvPlaylistEntry | null {
  const line = panelLine();
  if (!line) return null;
  const raw = `${line.serverUrl.replace(/\/+$/, "")} ${line.username} ${line.password}`;
  const m3uUrl = normalizeIptvInput(raw);
  if (!m3uUrl) return null;
  const epgUrl = normalizeEpgInputs(raw)[0] ?? "";
  return {
    id: PANEL_PLAYLIST_ID,
    name: line.displayName || "Live TV",
    m3uUrl,
    epgUrl,
    epgUrls: epgUrl ? [epgUrl] : [],
    enabled: true
  };
}

/** The panel line's playlist always comes first; any other playlists are dropped in panel mode. */
export function withPanelPlaylist(playlists: IptvPlaylistEntry[]): IptvPlaylistEntry[] {
  if (!config.panelMode) return playlists;
  const own = panelPlaylist();
  return own ? [own] : [];
}

/** Never sync the line's credentials through profile data; each device builds them from its sign-in. */
export function withoutPanelPlaylist(playlists: IptvPlaylistEntry[]): IptvPlaylistEntry[] {
  if (!config.panelMode) return playlists;
  return playlists.filter((playlist) => playlist.id !== PANEL_PLAYLIST_ID);
}

export async function fetchPanelPortals(): Promise<PanelPortal[]> {
  const response = await fetch("/api/panel/portals", { cache: "no-store" });
  if (!response.ok) throw new Error("Can't reach the service right now. Please try again.");
  const data = (await response.json()) as { portals?: Array<{ id?: number; name?: string }> };
  return (data.portals ?? [])
    .filter((p): p is { id: number; name: string } => typeof p.id === "number" && p.id > 0)
    .map((p) => ({ id: p.id, name: p.name || `Server ${p.id}` }));
}
