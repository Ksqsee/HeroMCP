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
    const names = tools.map((t: any) => t.name);
    for (const n of ["status", "search", "open_items", "list_receipts", "get_receipt", "file_link", "create_offer", "create_document", "record_payment", "graphql_query"])
      expect(names).toContain(n);
    // No tool may edit or delete: the names say so, and every writer declares itself non-destructive.
    expect(names.filter((n: string) => /delete|remove|update|edit|cancel|storno/i.test(n))).toEqual([]);
    for (const t of tools) {
      if (/^(create_|add_|log_|record_|schedule_)/.test(t.name)) expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      else expect(t.annotations?.readOnlyHint).toBe(true);
    }
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

describe("writes", () => {
  it("only create mutations pass the guard; edits and deletes never reach HERO", async () => {
    const { assertCreateOnly } = await import("../src/hero");
    expect(() => assertCreateOnly("mutation ($i: X) { create_document(input: $i, actions: []) { customer_document_id } }", {})).not.toThrow();
    for (const [q, v] of [
      ["mutation { delete_contact(id: 7) }", {}],
      ["mutation { update_customer_document(id: 7) }", {}],
      ["mutation { create_contact { id } delete_contact(id: 7) }", {}],
      ["mutation A { create_contact { id } } mutation B { delete_contact(id: 1) }", {}],
      ["query { contacts { id } }", {}],
      ["mutation ($t: TaskInput) { update_task(task: $t) { id } }", { t: { id: 5, title: "x" } }],
      ["mutation ($t: X) { update_tracking_time(tracking_time: $t) { id } }", { t: { uuid: "abc" } }],
      ['mutation { update_task(task: { id: 5, title: "x" }) { id } }', {}],
      ["mutation { ...F } fragment F on Mutation { delete_contact(id: 1) }", {}],
    ] as [string, Record<string, unknown>][])
      expect(() => assertCreateOnly(q, v), q).toThrow();
  });

  it("create_offer makes a draft by default, with the customer as recipient and HERO units", async () => {
    const { access_token } = await signIn();
    const r = await tool(access_token, "create_offer", {
      project_match_id: 2,
      positions: [{ name: "Waschtisch montieren", unit: "pauschal", quantity: 1, unit_price: 240 }],
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ document_id: 5000, entwurf: true });
    const made = hero.created.find((c) => c.name === "create_document")!;
    expect(made.variables).toMatchObject({ input: { document_type_id: 21, project_match_id: 2, publish: false } });
    const actions = made.variables.actions as any[];
    expect(actions[0].set_recipient).toMatchObject({ last_name: "Muster", city: "Köln" });
    expect(actions[1].add_product_position).toMatchObject({ unit_type: "Satz", net_price: 240, vat_percent: 19 });
    expect(hero.mutated).toBe(false);
  });

  it("the same write twice creates one document, unless repeat is set on purpose", async () => {
    const { access_token } = await signIn();
    const args = { project_match_id: 3, doc_type: "rechnung", positions: [{ name: "Abschlag 1", unit: "Stk", quantity: 1, unit_price: 1000 }] };
    await tool(access_token, "create_document", args);
    const second = await tool(access_token, "create_document", args);
    expect(second.data.bereits_angelegt).toBe(true);
    expect(hero.created.filter((c) => c.name === "create_document")).toHaveLength(1);
    await tool(access_token, "create_document", { ...args, repeat: true });
    expect(hero.created.filter((c) => c.name === "create_document")).toHaveLength(2);
  });

  it("a HERO refusal does not block a corrected retry", async () => {
    const { access_token } = await signIn();
    const bad = await tool(access_token, "create_document", { project_match_id: 1, doc_type: "mahnung", positions: [{ name: "x", unit: "Stk", quantity: 1, unit_price: 1 }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Verfügbar: Angebot, Rechnung, Allgemein");
    const badUnit = await tool(access_token, "create_document", { project_match_id: 1, doc_type: "rechnung", positions: [{ name: "x", unit: "Eimer", quantity: 1, unit_price: 1 }] });
    expect(badUnit.text).toContain("Erlaubt:");
    expect(hero.created).toHaveLength(0);
  });

  it("add_task creates, and cannot be turned into an edit", async () => {
    const { access_token } = await signIn();
    const r = await tool(access_token, "add_task", { project_match_id: 1, title: "Material bestellen", due: "2026-11-03T08:00:00+01:00" });
    expect(r.data).toMatchObject({ id: 77 });
    expect((hero.created[0].variables.task as any).id).toBeUndefined();
    const sneaky = await tool(access_token, "add_task", { project_match_id: 1, title: "x", due: "2026-11-03T08:00:00+01:00", id: 5 } as any);
    expect(hero.created.filter((c) => (c.variables.task as any)?.id)).toHaveLength(0);
    expect(sneaky.isError || sneaky.data?.id === 77).toBe(true);
  });

  it("record_payment refuses more than the open amount and does not pay drafts", async () => {
    const { access_token } = await signIn();
    const over = await tool(access_token, "record_payment", { document_id: 1000, amount: 500, date: "2026-10-26" });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("offene Restbetrag 100");
    const draft = await tool(access_token, "record_payment", { document_id: 5000, amount: 10, date: "2026-10-26" });
    expect(draft.isError).toBe(true);
    const ok = await tool(access_token, "record_payment", { document_id: 1000, amount: 100, date: "2026-10-26" });
    expect(ok.isError).toBe(false);
    expect(hero.created.filter((c) => c.name === "create_payment")).toHaveLength(1);
  });

  it("graphql_query still cannot write, not even allowed create mutations", async () => {
    const { access_token } = await signIn();
    const r = await tool(access_token, "graphql_query", { query: 'mutation { create_document(input: {}, actions: []) { customer_document_id } }' });
    expect(r.isError).toBe(true);
    expect(hero.created).toHaveLength(0);
  });
});

describe("v9 reads", () => {
  it("open_items pages through every invoice, not just the newest 200", async () => {
    const { access_token } = await signIn();
    const { data } = await tool(access_token, "open_items", { as_of: "2026-10-26" });
    expect(data.vollstaendig).toBe(true);
    expect(data.anzahl).toBe(150);
    expect(data.summe).toBe(15000);
    expect(data.posten[0].tage_ueberfaellig).toBeGreaterThan(200);
    const pages = hero.calls.filter((c) => c.query.includes("customer_document_booking") && c.variables.t);
    expect(pages.map((c) => c.variables.o)).toEqual([0, 200, 400]);
  });

  it("receipts (Eingangsbelege) can be listed and read with their file", async () => {
    const { access_token } = await signIn();
    const list = await tool(access_token, "list_receipts", {});
    expect(list.data.items[0]).toMatchObject({ number: "ER-3", customer: { last_name: "Muster" } });
    const one = await tool(access_token, "get_receipt", { id: "3" });
    expect(one.data.file_upload.filename).toBe("er3.pdf");
  });
});
