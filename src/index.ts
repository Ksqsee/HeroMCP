import OAuthProvider, { type AuthRequest, type OAuthHelpers, OAuthError } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env as globalEnv } from "cloudflare:workers";
import { buildServer, type Props } from "./tools";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  HERO_URL: string;
  HERO_API_KEY: string;
  PUBLIC_URL: string;
  LOGIN_LIMIT: RateLimit;
  REGISTER_LIMIT: RateLimit;
}

// Only Claude may receive sign-ins, so nobody can register a look-alike app
// and use this login page to phish a colleague's access code.
export const ALLOWED_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

/** Access codes are stored only as SHA-256 hashes: KV key "user:<hash>" holds the person's name. */
export async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code.trim()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const userFor = (env: Env, codeHash: string) => env.OAUTH_KV.get(`user:${codeHash}`);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(handle: string, redirectHost: string, error = ""): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HERO für Claude – Anmelden</title>
<style>
body{font-family:system-ui,sans-serif;background:#f4f4f5;margin:0;display:grid;place-items:center;min-height:100vh}
form{background:#fff;padding:2rem;border-radius:12px;max-width:22rem;width:calc(100% - 2rem);box-shadow:0 1px 4px #0002}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#52525b;margin:0 0 1rem;font-size:.9rem}
label{display:block;margin-bottom:.35rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;margin-bottom:1rem;border:1px solid #a1a1aa;border-radius:6px}
button{width:100%;padding:.7rem;font-size:1rem;background:#1d4ed8;color:#fff;border:0;border-radius:8px;cursor:pointer}
.err{color:#b91c1c;font-weight:600}
</style></head><body>
<form method="post">
<h1>HERO für Claude</h1>
<p>Geben Sie Ihren persönlichen Zugangscode ein. Claude kann danach in HERO lesen und Neues anlegen (Kunden, Projekte, Entwürfe, Termine, Zeiten, Zahlungen), aber nichts Bestehendes ändern oder löschen.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="c">Zugangscode</label>
<input id="c" name="code" type="password" autocomplete="off" required autofocus>
<button type="submit">Anmelden</button>
<p style="margin:1rem 0 0;font-size:.8rem">Zugriff geht an: ${esc(redirectHost)}</p>
</form></body></html>`;
}

const html = (body: string, headers: Headers, status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
};

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") {
    let auth: AuthRequest;
    try {
      auth = await oauth.parseAuthRequest(request);
    } catch {
      return new Response("Ungültige Anmeldeanfrage.", { status: 400 });
    }
    if (!ALLOWED_REDIRECTS.has(auth.redirectUri)) return new Response("Nicht erlaubt.", { status: 400 });
    const consent = await oauth.beginConsent(auth);
    return html(page(consent.handle, new URL(auth.redirectUri).host), consent.headers);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.LOGIN_LIMIT.limit({ key: ip })).success)
    return new Response("Zu viele Anmeldeversuche. Bitte eine Minute warten.", { status: 429 });

  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const codeHash = await hashCode(String(form.get("code") ?? ""));
  const user = await userFor(env, codeHash);
  if (!user) {
    await new Promise((r) => setTimeout(r, 1000)); // slows guessing; codes are 128-bit anyway
    const headers = new Headers({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Cache-Control": "no-store" });
    return html(page(handle, "claude.ai", "Zugangscode ungültig."), headers, 401);
  }
  try {
    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: codeHash,
      metadata: { user },
      scope: approved.request.scope,
      props: { user, codeHash } satisfies Props,
    });
    console.log(`login ok: ${user}`);
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    console.error(e);
    return new Response("Die Anmeldung ist abgelaufen. Bitte in Claude erneut auf Verbinden klicken.", { status: 400 });
  }
}

const mcp = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }) {
    // Removing a person's code ends their access, even for tokens already issued.
    if (!(await userFor(env, ctx.props.codeHash)))
      return Response.json({ error: "invalid_token", error_description: "Access revoked" }, { status: 401 });
    return createMcpHandler(() => buildServer(env.HERO_URL, env.HERO_API_KEY, ctx.props, env.OAUTH_KV))(request, env, ctx);
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcp as any,
  defaultHandler: {
    fetch(request: Request, env: Env) {
      if (new URL(request.url).pathname === "/authorize") return authorize(request, env);
      return new Response("HERO MCP. In Claude als Connector hinzufügen: <diese Adresse>/mcp", { status: 404 });
    },
  } as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  resourceMetadata: { resource: `${(globalEnv as unknown as Env).PUBLIC_URL.replace(/\/+$/, "")}/mcp` },
  clientRegistrationCallback: ({ clientMetadata }) => {
    const uris = (clientMetadata.redirect_uris as unknown[]) ?? [];
    if (!uris.length || !uris.every((u) => typeof u === "string" && ALLOWED_REDIRECTS.has(u)))
      return { code: "invalid_redirect_uri", description: "Only Claude may connect to this server." };
  },
  // A removed person cannot refresh their way back in.
  tokenExchangeCallback: async ({ grantType, props, env }) => {
    if (grantType !== "refresh_token") return;
    if (!(await userFor(env as Env, (props as Props).codeHash)))
      throw new OAuthError("invalid_grant", { description: "Access revoked" });
  },
});

// Anonymous endpoints that write to KV (client registration, opening the login page)
// get a per-IP limit, so nobody can fill storage or burn the daily KV write quota.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const writes = (pathname === "/register" && request.method === "POST") || (pathname === "/authorize" && request.method === "GET");
    if (writes && !(await env.REGISTER_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" })).success)
      return new Response("Too many requests", { status: 429 });
    return provider.fetch(request, env, ctx);
  },
};
