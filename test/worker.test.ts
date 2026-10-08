import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashCode } from "../src/index";
import { type FakeState, fakeHero, newState } from "./fake-hero";

const ORIGIN = "https://hero-mcp.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CODE = "anna-secret-code";
const kv = (env as any).OAUTH_KV as KVNamespace;
let hero: FakeState;

beforeEach(async () => {
  hero = newState();
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeHero(hero));
  await kv.put(`user:${await hashCode(CODE)}`, "Anna Muster");
});
afterEach(() => vi.restoreAllMocks());

const call = (path: string, init?: RequestInit) => (exports as any).default.fetch(new Request(`${ORIGIN}${path}`, init));

async function register(redirect = CALLBACK) {
  return call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Claude" }),
  });
}

async function pkce() {
  const verifier = "v".repeat(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

/** Open the login page like a browser would: returns the form handle and cookie. */
async function openLogin() {
  const { client_id } = (await (await register()).json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const qs = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${ORIGIN}/mcp`,
  });
  const page = await call(`/authorize?${qs}`, { headers: { "CF-Connecting-IP": crypto.randomUUID() } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const cookie = page.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ");
  return { client_id, verifier, handle, cookie, html, headers: page.headers };
}

function submit(login: { handle: string; cookie: string }, code: string, ip = crypto.randomUUID()) {
  return call("/authorize", {
    method: "POST",
    headers: { Cookie: login.cookie, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: new URLSearchParams({ handle: login.handle, code }),
    redirect: "manual",
  });
}

async function signIn() {
  const login = await openLogin();
  const res = await submit(login, CODE);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  expect(loc.origin + loc.pathname).toBe(CALLBACK);
  expect(loc.searchParams.get("state")).toBe("xyz");
  const token = await call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: loc.searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: login.client_id,
      code_verifier: login.verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return { ...((await token.json()) as { access_token: string; refresh_token: string }), client_id: login.client_id };
}

async function mcp(token: string | null, method: string, params: object = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await call("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status !== 200) return { status: res.status, body: null as any };
  const text = await res.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)![1]);
  return { status: 200, body: json };
}

async function tool(token: string, name: string, args: object) {
  const { body } = await mcp(token, "tools/call", { name, arguments: args });
  const text = body.result.content[0].text as string;
  return { isError: !!body.result.isError, text, data: body.result.isError ? null : JSON.parse(text) };
}

const lastQuery = () => hero.calls.filter((c) => !c.query.includes("__schema")).at(-1)!;

describe("sign-in", () => {
  it("full OAuth flow gives a token that works, and nothing works without one", async () => {
    const { access_token } = await signIn();
    expect((await mcp(null, "tools/list")).status).toBe(401);
    const list = await mcp(access_token, "tools/list");
    const tools = list.body.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "describe_schema",
      "get_contact",
      "get_project",
      "graphql_query",
      "list_calendar_events",
      "list_contacts",
      "list_documents",
      "list_products",
      "list_projects",
      "status",
    ]);
    expect(tools.every((t: any) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("wrong access code shows the form again and the same form still works afterwards", async () => {
    const login = await openLogin();
    const bad = await submit(login, "falsch");
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Zugangscode ungültig");
    expect((await submit(login, CODE)).status).toBe(302);
  });

  it("refuses to register apps that are not Claude", async () => {
    expect((await register("https://evil.example/cb")).status).toBe(400);
    expect((await register("https://claude.ai.evil.example/api/mcp/auth_callback")).status).toBe(400);
  });

  it("login page cannot be framed", async () => {
    const login = await openLogin();
    const frame = `${login.headers.get("X-Frame-Options")} ${login.headers.get("Content-Security-Policy")}`;
    expect(frame).toMatch(/DENY|frame-ancestors 'none'/);
  });

  it("form handle without the browser cookie is rejected (no CSRF)", async () => {
    const login = await openLogin();
    expect((await submit({ ...login, cookie: "" }, CODE)).status).toBe(400);
  });

  it("removing a person ends their access and their refreshes", async () => {
    const { access_token, refresh_token, client_id } = await signIn();
    expect((await mcp(access_token, "tools/list")).status).toBe(200);
    await kv.delete(`user:${await hashCode(CODE)}`);
    expect((await mcp(access_token, "tools/list")).status).toBe(401);
    const refresh = await call("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id }),
    });
    expect(refresh.status).not.toBe(200);
  });

  it("rate-limits code guessing per IP", { timeout: 30_000 }, async () => {
    const login = await openLogin();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await submit(login, "falsch", "9.9.9.9")).status);
    expect(statuses).toContain(429);
  });
});

describe("abuse", () => {
  it("anonymous client registration is rate-limited per IP", async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++)
      statuses.push(
        (
          await call("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
            body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }),
          })
        ).status,
      );
    expect(statuses).toContain(429);
  });

  it("the API key is never sent along a redirect, and HERO error bodies stay out of the logs", async () => {
    const { access_token } = await signIn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    hero.respond = () => new Response("Kunde Müller, Rechnung R-1 fehlgeschlagen", { status: 500 });
    const r = await tool(access_token, "graphql_query", { query: "{ contacts { id } }" });
    expect(r.isError).toBe(true);
    expect(hero.calls.every((c) => c.redirect === "manual")).toBe(true);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Müller");
  });
});

describe("tools", () => {
  it("status uses the API key and reports the person", async () => {
    const { access_token } = await signIn();
    const { data } = await tool(access_token, "status", {});
    expect(data).toEqual({ connected: true, user: "Anna Muster" });
    expect(hero.calls.every((c) => c.auth === "Bearer hero-key")).toBe(true);
  });

  it("list_projects pages on the server, searches via variables, and includes nested data", async () => {
    const { access_token } = await signIn();
    const { data } = await tool(access_token, "list_projects", { search: 'x") { id } }', limit: 2, offset: 1 });
    const q = lastQuery();
    expect(q.variables).toEqual({ search: 'x") { id } }', first: 2, offset: 1 });
    expect(q.query).not.toContain("x\")");
    expect(q.query).not.toContain("secret");
    expect(data.items.map((p: any) => p.project_nr)).toEqual(["P-2", "P-3"]);
    expect(data.items[0]).toMatchObject({
      customer: { last_name: "Muster", address: { city: "Köln" } },
      current_project_match_status: { status_code: 100, name: "Angebot" },
    });
  });

  it("get_project brings documents with file links and logbook entries", async () => {
    const { access_token } = await signIn();
    const { data } = await tool(access_token, "get_project", { id: "2" });
    expect(lastQuery().variables).toEqual({ ids: [2] });
    expect(data.project_nr).toBe("P-2");
    expect(data.customer_documents[0]).toMatchObject({ nr: "R-1", file_upload: { url: "https://files.test/r1.pdf" } });
    expect(data.histories[0].custom_title).toBe("Anruf");
  });

  it("lists with a page size but no offset argument fetch only what the page needs", async () => {
    const { access_token } = await signIn();
    const { data } = await tool(access_token, "list_calendar_events", { limit: 2, offset: 1, arguments: { start: "2026-02-01" } });
    expect(data.items.map((e: any) => e.id)).toEqual([2, 3]);
    expect(lastQuery().variables).toEqual({ start: "2026-02-01", first: 3 });
  });

  it("unknown arguments and missing search fail with a helpful message", async () => {
    const { access_token } = await signIn();
    const bad = await tool(access_token, "list_documents", { arguments: { drop_table: 1 } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Available: project_match_id: Int");
    const noSearch = await tool(access_token, "list_documents", { search: "R-1" });
    expect(noSearch.isError).toBe(true);
    expect(noSearch.text).toContain("no free-text search");
  });

  it("numbers sent as strings are coerced to the schema's types", async () => {
    const { access_token } = await signIn();
    await tool(access_token, "list_documents", { arguments: '{"project_match_id": "3"}' });
    expect(lastQuery().variables).toMatchObject({ project_match_id: 3 });
  });

  it("describe_schema shows queries but never mutations", async () => {
    const { access_token } = await signIn();
    const { data } = await tool(access_token, "describe_schema", {});
    const names = data.queries.map((q: any) => q.name);
    expect(names).toContain("project_matches");
    expect(names).not.toContain("delete_contact");
    const t = await tool(access_token, "describe_schema", { type: "Status" });
    expect(t.data.fields.map((f: any) => f.name)).toEqual(["status_code", "name"]);
  });

  it("graphql_query reads but cannot change or delete anything", async () => {
    const { access_token } = await signIn();
    const read = await tool(access_token, "graphql_query", { query: "query($id: [Int]) { contacts(ids: $id) { last_name } }", variables: { id: [7] } });
    expect(read.data).toEqual({ contacts: [{ last_name: "Muster" }] });
    const before = hero.calls.length;
    for (const query of [
      "mutation { delete_contact(id: 7) }",
      'mutation M { create_contact(first_name: "x") { id } }',
      "query { contacts { id } } mutation { delete_contact(id: 7) }",
      "subscription { contacts { id } }",
      "{ contacts { id } ",
    ]) {
      const r = await tool(access_token, "graphql_query", { query });
      expect(r.isError).toBe(true);
    }
    expect(hero.calls.length).toBe(before);
    expect(hero.mutated).toBe(false);
  });

  it("ids cannot smuggle GraphQL into the query", async () => {
    const { access_token } = await signIn();
    const r = await tool(access_token, "get_contact", { id: "7) { id } } mutation { delete_contact(id: 7" });
    expect(r.isError).toBe(true);
    expect(hero.mutated).toBe(false);
  });
});
