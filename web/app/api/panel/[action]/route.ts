import { NextRequest, NextResponse } from "next/server";

/**
 * Panel mode backend (NEXT_PUBLIC_PANEL_MODE=true). Speaks the ARVIO Cloud backend's routes to the
 * browser and translates them to the ARVIO panel's app API, so the browser never learns the
 * panel's address. Server settings:
 *   PANEL_API_URL   the panel's app API, e.g. https://example.com/arvio-panel/api/arvio/
 *   PANEL_WEB_KEY   optional; Panel > Settings > Web app. Lets the panel see viewers' real IPs.
 */

export const dynamic = "force-dynamic";

const TEN_YEARS = 10 * 365 * 86400;
const MAX_SYNC_BYTES = 8 * 1024 * 1024;

function panelBase(): string | null {
  const raw = (process.env.PANEL_API_URL || "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw.endsWith("/") ? raw : raw + "/";
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "";
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function bearer(request: NextRequest): string {
  const value = request.headers.get("authorization") ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

async function panelFetch(request: NextRequest, route: string, init: { method?: string; body?: string; token?: string } = {}) {
  const base = panelBase();
  if (!base) throw new Error("not_configured");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Arvio-Version": "web",
    "User-Agent": "ARVIO-Web"
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const key = (process.env.PANEL_WEB_KEY || "").trim();
  const ip = clientIp(request);
  if (key && ip) {
    headers["X-Arvio-Web-Key"] = key;
    headers["X-Arvio-Client-IP"] = ip;
  }
  return fetch(base + route, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
}

/** Passes the panel's reply (status and JSON body) straight back. */
async function relay(response: Response) {
  const text = await response.text();
  return new NextResponse(text || "{}", {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function errorFrom(response: Response) {
  let message = "The service returned an error. Please try again.";
  try {
    const body = JSON.parse(await response.text()) as { message?: string };
    if (body.message) message = body.message;
  } catch { /* keep the generic message */ }
  return json({ error: message, message }, response.status);
}

function sessionReply(token: string, user: { id?: string; email?: string; display_name?: string; server_url?: string }) {
  return {
    access_token: token,
    refresh_token: token,
    token_type: "bearer",
    expires_in: TEN_YEARS,
    user: { id: user.id ?? "", email: user.email ?? "" },
    line: { server_url: user.server_url ?? "", display_name: user.display_name ?? "" }
  };
}

async function handle(request: NextRequest, action: string) {
  const method = request.method;
  const token = bearer(request);

  switch (action) {
    case "portals": {
      const response = await panelFetch(request, "portals");
      if (!response.ok) return errorFrom(response);
      const data = (await response.json()) as { portals?: Array<{ id?: number; name?: string }> };
      // Server addresses stay on this server.
      return json({ portals: (data.portals ?? []).map((p) => ({ id: p.id, name: p.name })) });
    }

    case "auth-login": {
      if (method !== "POST") break;
      const raw = await request.text();
      if (raw.length > 8192) return json({ error: "Request too large" }, 413);
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(raw) as Record<string, unknown>; } catch { /* handled below */ }
      const body = JSON.stringify({
        username: String(input.username ?? input.email ?? "").trim(),
        password: String(input.password ?? ""),
        server_id: Number(input.server_id) || undefined,
        device_id: String(input.device_id ?? "").slice(0, 120),
        device_name: String(input.device_name ?? "Web browser").slice(0, 120)
      });
      const response = await panelFetch(request, "api/auth/login", { method: "POST", body });
      if (!response.ok) return errorFrom(response);
      const data = (await response.json()) as {
        user?: { id?: string; email?: string; display_name?: string; server_url?: string };
        tokens?: { access_token?: string };
      };
      const accessToken = data.tokens?.access_token;
      if (!accessToken || !data.user) return json({ error: "Sign-in failed. Please try again." }, 502);
      return json(sessionReply(accessToken, data.user));
    }

    case "auth-refresh": {
      // Panel sessions don't expire; this just confirms the line can still sign in.
      if (method !== "POST") break;
      let refreshToken = token;
      try { refreshToken = String((JSON.parse(await request.text()) as { refresh_token?: string }).refresh_token ?? "") || token; } catch { /* use header */ }
      if (!refreshToken) return json({ error: "Sign in required" }, 401);
      const response = await panelFetch(request, "me", { token: refreshToken });
      if (!response.ok) return errorFrom(response);
      const data = (await response.json()) as { user?: { id?: string; email?: string; display_name?: string; server_url?: string } };
      return json(sessionReply(refreshToken, data.user ?? {}));
    }

    case "account-sync-pull": {
      if (!token) return json({ error: "Sign in required" }, 401);
      const response = await panelFetch(request, "account", { token });
      if (!response.ok) return errorFrom(response);
      const payload = await response.text();
      return json({ payload: payload || "{}", source: "panel", updatedAt: new Date().toISOString() });
    }

    case "account-sync-push": {
      if (method !== "POST") break;
      if (!token) return json({ error: "Sign in required" }, 401);
      const raw = await request.text();
      if (raw.length > MAX_SYNC_BYTES + 1024) return json({ accepted: false, reason: "too_large" }, 413);
      let payload: unknown;
      try { payload = (JSON.parse(raw) as { payload?: unknown }).payload; } catch { return json({ accepted: false, reason: "invalid" }, 400); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ accepted: false, reason: "invalid" }, 400);
      const response = await panelFetch(request, "account", { method: "POST", token, body: JSON.stringify(payload) });
      if (!response.ok) return errorFrom(response);
      return json({ accepted: true });
    }

    case "me":
    case "addons":
    case "collections":
    case "keys": {
      if (!token) return json({ error: "Sign in required" }, 401);
      return relay(await panelFetch(request, action, { token }));
    }

    case "collection": {
      if (!token) return json({ error: "Sign in required" }, 401);
      const id = Number(new URL(request.url).searchParams.get("id"));
      if (!Number.isInteger(id) || id <= 0) return json({ error: "Missing id" }, 400);
      return relay(await panelFetch(request, `collection?id=${id}`, { token }));
    }

    case "logout": {
      if (method !== "POST") break;
      if (token) await panelFetch(request, "logout", { method: "POST", token, body: "{}" }).catch(() => undefined);
      return json({ ok: true });
    }

    // ARVIO Cloud extras that a panel installation doesn't have.
    case "entitlement-status":
      return json({ entitled: true, reason: "subscription", status: "active", source: "panel", expiresAt: null, trialAvailable: false });
    case "premium-funnel-event":
      return new NextResponse(null, { status: 204 });
    case "catalog-packs-list":
      return json({ packs: [] });
  }
  return json({ error: "Not found" }, 404);
}

async function entry(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  if (process.env.NEXT_PUBLIC_PANEL_MODE !== "true") return json({ error: "Not found" }, 404);
  const { action } = await context.params;
  try {
    return await handle(request, action);
  } catch (error) {
    if (error instanceof Error && error.message === "not_configured") {
      return json({ error: "This web app isn't connected to a panel yet (PANEL_API_URL)." }, 503);
    }
    return json({ error: "Can't reach the service right now. Please try again." }, 502);
  }
}

export const GET = entry;
export const POST = entry;
