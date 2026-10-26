// A small executable stand-in for HERO's GraphQL API, including mutations the server must never call.
import { buildSchema, graphql } from "graphql";

export const HERO = "https://hero.test/graphql";
export const KEY = "hero-key";

export interface FakeState {
  calls: { url: string; auth: string | null; redirect: string | undefined; query: string; variables: Record<string, unknown> }[];
  mutated: boolean;
  /** Every create mutation that reached HERO, with its variables. */
  created: { name: string; variables: Record<string, unknown> }[];
  /** When set, HERO answers every request with this response instead. */
  respond?: () => Response;
}

export const newState = (): FakeState => ({ calls: [], mutated: false, created: [] });

const schema = buildSchema(`
  type Query {
    contacts(ids: [Int], search: String, first: Int, offset: Int): [Contact]
    project_matches(ids: [Int], search: String, status_code: Int, first: Int, offset: Int): [ProjectMatch]
    customer_documents(project_match_id: Int, ids: [Int], document_type_ids: [Int], first: Int, offset: Int, orderBy: String): [CustomerDocument]
    calendar_events(start: String, first: Int): [CalendarEvent]
    supply_product_versions(search: String, first: Int, offset: Int): [Product]
    receipts(ids: [Int], first: Int, offset: Int): [Receipt]
    company: Company
    user: User
    project_types(is_active: Boolean): [ProjectType]
    document_types(show_deleted: Boolean): [DocumentType]
    calendar_event_categories(show_deleted: Boolean): [Named]
    project_match(project_match_id: Int): ProjectMatch
  }
  type Mutation {
    create_contact(first_name: String): Contact
    delete_contact(id: Int): Boolean
    create_document(input: Documents_CreateDocumentInput!, actions: [Documents_DocumentBuilderActionInput!]!): CreatedDocument
    create_payment(document_id: Int!, payment: PaymentInput!): CustomerDocument
    update_task(task: TaskInput): Task
    update_customer_document(id: Int): Boolean
  }
  scalar Documents_DocumentBuilderActionInput
  input Documents_CreateDocumentInput { document_type_id: Int project_match_id: Int publish: Boolean }
  input PaymentInput { paid_date: String value: Float }
  input TaskInput { id: Int title: String comment: String due_date: String target_project_match_id: Int }
  type CreatedDocument { customer_document_id: Int }
  type Task { id: Int title: String comment: String due_date: String target_project_match_id: Int }
  type Named { id: Int name: String }
  type Company { id: Int name: String measures: [Measure] }
  type User { id: Int email: String partner: Partner }
  type Partner { id: Int full_name: String }
  type ProjectType { id: Int name: String is_default: Boolean is_active: Boolean project_status_steps: [Named] }
  type DocumentType { id: Int name: String base_type: String is_active: Boolean }
  type Payment { value: Float paid_date: String }
  type Booking { is_open: Boolean due_date: String payments: [Payment] }
  type Receipt { id: Int number: String value: Float paid_sum: Float customer: Contact file_upload: FileUpload }
  type Address { street: String city: String zipcode: String }
  type Contact { id: Int nr: String title: String full_name: String address_id: Int first_name: String last_name: String company_name: String email: String phone_home: String address: Address }
  type Measure { id: Int short: String name: String }
  type Status { status_code: Int name: String }
  type FileUpload { uuid: String url: String filename: String }
  type CustomerDocument { id: Int type: String nr: String value: Float vat: Float date: String created: String status_code: Int status_name: String project_match_id: Int file_upload: FileUpload contact: Contact customer_document_booking: Booking }
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

// 450 invoices, newest first; every third one still open and overdue.
const invoices = Array.from({ length: 450 }, (_, i) => ({
  id: 1000 + i,
  nr: `R-${1000 + i}`,
  type: "invoice",
  value: 100,
  date: "2026-01-01",
  status_code: 200,
  contact: anna,
  customer_document_booking: { is_open: i % 3 === 0, due_date: "2026-02-01", payments: i % 3 === 0 ? [] : [{ value: 100, paid_date: "2026-01-20" }] },
}));

const page = <T>(items: T[], a: { first?: number; offset?: number }) => items.slice(a.offset ?? 0, (a.offset ?? 0) + (a.first ?? items.length));

const root = (state: FakeState) => ({
  contacts: (a: any) => page([anna].filter((c) => (!a.ids || a.ids.includes(c.id)) && (!a.search || c.last_name.includes(a.search))), a),
  project_matches: (a: any) => page(projects.filter((p) => !a.ids || a.ids.includes(p.id)), a),
  customer_documents: (a: any) => {
    if (a.ids) return ([...docs, ...invoices] as any[]).filter((d) => a.ids.includes(d.id)).concat(a.ids.includes(5000) ? [{ id: 5000, nr: null, status_name: "Entwurf", value: 238 }] : []);
    if (a.document_type_ids) return page(invoices, a);
    return page(docs, a);
  },
  receipts: (a: any) => page([{ id: 3, number: "ER-3", value: 59.5, paid_sum: 0, customer: anna, file_upload: { url: "https://files.test/er3.pdf", filename: "er3.pdf" } }], a),
  company: () => ({ id: 1, name: "Muster GmbH", measures: [{ id: 9, short: "PRJ", name: "Projekt" }] }),
  user: () => ({ id: 2, email: "chef@example.com", partner: { id: 4, full_name: "Chef" } }),
  project_types: () => [{ id: 11, name: "Standard", is_default: true, is_active: true, project_status_steps: [{ id: 1, name: "Neu" }] }],
  document_types: () => [
    { id: 21, name: "Angebot", base_type: "offer", is_active: true },
    { id: 22, name: "Rechnung", base_type: "invoice", is_active: true },
    { id: 23, name: "Allgemein", base_type: "letter", is_active: true },
  ],
  calendar_event_categories: () => [{ id: 31, name: "Baustelle" }],
  project_match: (a: any) => projects.find((p) => p.id === a.project_match_id) ?? null,
  create_document: (a: any) => (state.created.push({ name: "create_document", variables: a }), { customer_document_id: 5000 }),
  create_payment: (a: any) => (state.created.push({ name: "create_payment", variables: a }), { id: a.document_id }),
  update_task: (a: any) => (state.created.push({ name: "update_task", variables: a }), { id: 77, title: a.task.title }),
  update_customer_document: () => ((state.mutated = true), true),
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
