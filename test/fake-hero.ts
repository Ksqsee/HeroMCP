// A small executable stand-in for HERO's GraphQL API, including mutations the server must never call.
import { buildSchema, graphql } from "graphql";

export const HERO = "https://hero.test/graphql";
export const KEY = "hero-key";

export interface FakeState {
  calls: { url: string; auth: string | null; redirect: string | undefined; query: string; variables: Record<string, unknown> }[];
  mutated: boolean;
  /** When set, HERO answers every request with this response instead. */
  respond?: () => Response;
}

export const newState = (): FakeState => ({ calls: [], mutated: false });

const schema = buildSchema(`
  type Query {
    contacts(ids: [Int], search: String, first: Int, offset: Int): [Contact]
    project_matches(ids: [Int], search: String, status_code: Int, first: Int, offset: Int): [ProjectMatch]
    customer_documents(project_match_id: Int, first: Int, offset: Int): [CustomerDocument]
    calendar_events(start: String, first: Int): [CalendarEvent]
    supply_product_versions(search: String, first: Int, offset: Int): [Product]
  }
  type Mutation {
    create_contact(first_name: String): Contact
    delete_contact(id: Int): Boolean
  }
  type Address { street: String city: String zipcode: String }
  type Contact { id: Int nr: String first_name: String last_name: String company_name: String email: String phone_home: String address: Address }
  type Measure { short: String name: String }
  type Status { status_code: Int name: String }
  type FileUpload { url: String filename: String }
  type CustomerDocument { id: Int type: String nr: String value: Float created: String file_upload: FileUpload }
  type History { custom_title: String custom_text: String created: String }
  type ProjectMatch {
    id: Int project_nr: String measure: Measure customer: Contact contact: Contact address: Address
    current_project_match_status: Status customer_documents: [CustomerDocument] histories: [History]
    secret(level: Int!): String
  }
  type CalendarEvent { id: Int title: String start: String }
  type Product { id: Int name: String price: Float }
`);

const anna = { id: 7, nr: "K-7", first_name: "Anna", last_name: "Muster", email: "anna@example.com", address: { street: "Hauptstr. 1", city: "Köln", zipcode: "50667" } };
const docs = [{ id: 1, type: "invoice", nr: "R-1", value: 1190, created: "2026-01-02", file_upload: { url: "https://files.test/r1.pdf", filename: "r1.pdf" } }];
const projects = [1, 2, 3].map((i) => ({
  id: i,
  project_nr: `P-${i}`,
  measure: { short: "SAN", name: "Sanitär" },
  customer: anna,
  address: anna.address,
  current_project_match_status: { status_code: 100, name: "Angebot" },
  customer_documents: docs,
  histories: [{ custom_title: "Anruf", custom_text: "Kunde ruft zurück", created: "2026-01-03" }],
  secret: () => "never selected",
}));

const page = <T>(items: T[], a: { first?: number; offset?: number }) => items.slice(a.offset ?? 0, (a.offset ?? 0) + (a.first ?? items.length));

const root = (state: FakeState) => ({
  contacts: (a: any) => page([anna].filter((c) => (!a.ids || a.ids.includes(c.id)) && (!a.search || c.last_name.includes(a.search))), a),
  project_matches: (a: any) => page(projects.filter((p) => !a.ids || a.ids.includes(p.id)), a),
  customer_documents: (a: any) => page(docs, a),
  calendar_events: (a: any) => page([1, 2, 3, 4].map((i) => ({ id: i, title: `Termin ${i}`, start: `2026-02-0${i}` })), a),
  supply_product_versions: (a: any) => page([{ id: 1, name: "Rohr", price: 2.5 }], a),
  create_contact: () => ((state.mutated = true), anna),
  delete_contact: () => ((state.mutated = true), true),
});

export function fakeHero(state: FakeState) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    if (req.url !== HERO) return new Response("not reachable", { status: 599 });
    const body = (await req.json()) as { query: string; variables?: Record<string, unknown> };
    state.calls.push({ url: req.url, auth: req.headers.get("Authorization"), redirect: init?.redirect, query: body.query, variables: body.variables ?? {} });
    if (state.respond) return state.respond();
    if (req.headers.get("Authorization") !== `Bearer ${KEY}`) return new Response("unauthorized", { status: 401 });
    const result = await graphql({ schema, source: body.query, variableValues: body.variables, rootValue: root(state) });
    return Response.json(result);
  };
}
