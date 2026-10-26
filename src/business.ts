// Business tools for HERO API v9: day-to-day reads and create-only writes.
// Queries and field names follow what HERO's v9 API accepts; every write goes through
// Hero.mutate, which only lets "create" mutations through.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { argName, type Hero, HeroError, InputError } from "./hero";

export interface Ctx {
  hero: Hero;
  kv: KVNamespace;
  user: string;
  url: string;
}

type Run = (fn: () => Promise<unknown>) => Promise<unknown>;

// ── Company configuration (document types, project stages, …), cached per endpoint ──

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

export interface Config {
  projectTypeId: number | null;
  measureId: number | null;
  partnerId: number | null;
  documentTypes: Record<string, number>;
  documentTypeNames: string[];
  calendarCategories: Record<string, number>;
}

const DISCOVERY = `query {
  company { id name measures { id name short } }
  user { id email partner { id full_name } }
  project_types(is_active: true) { id name is_default is_active project_status_steps { id } }
  document_types(show_deleted: false) { id name base_type is_active }
  calendar_event_categories(show_deleted: false) { id name }
}`;

const CONFIG_TTL = 60 * 60 * 6;

export async function config(ctx: Ctx): Promise<Config> {
  const key = `cfg:${ctx.url}`;
  const cached = await ctx.kv.get<Config>(key, "json");
  if (cached) return cached;
  const d = await ctx.hero.query(DISCOVERY);
  const types = ((d.project_types ?? []) as any[]).filter((t) => t.is_active !== false);
  const defType = types.find((t) => t.is_default) ?? [...types].sort((a, b) => (b.project_status_steps?.length ?? 0) - (a.project_status_steps?.length ?? 0))[0];
  const documentTypes: Record<string, number> = {};
  const documentTypeNames: string[] = [];
  for (const t of (d.document_types ?? []) as any[]) {
    if (t.is_active === false) continue;
    documentTypes[norm(t.name)] = t.id;
    if (t.base_type && !(norm(t.base_type) in documentTypes)) documentTypes[norm(t.base_type)] = t.id;
    documentTypeNames.push(t.name);
  }
  const calendarCategories: Record<string, number> = {};
  for (const c of (d.calendar_event_categories ?? []) as any[]) calendarCategories[norm(c.name)] = c.id;
  const measures = (d.company?.measures ?? []) as any[];
  const measure = measures.find((m) => ["prj", "projekt"].includes(norm(m.short)) || norm(m.name) === "projekt") ?? measures[0];
  const cfg: Config = {
    projectTypeId: defType?.id ?? null,
    measureId: measure?.id ?? null,
    partnerId: d.user?.partner?.id ?? null,
    documentTypes,
    documentTypeNames,
    calendarCategories,
  };
  await ctx.kv.put(key, JSON.stringify(cfg), { expirationTtl: CONFIG_TTL });
  return cfg;
}

const ALIASES: Record<string, (x: string) => boolean> = {
  rechnung13b: (x) => x.includes("13b"),
  rechnung: (x) => x.includes("rechnung") && !x.includes("13b") && !x.includes("gutschrift") && !x.includes("storno"),
  angebot: (x) => x.includes("angebot") && !x.includes("bestaetigung"),
  gutschrift: (x) => x.includes("gutschrift"),
  auftragsbestaetigung: (x) => x.includes("auftragsbest"),
  lieferschein: (x) => x.includes("lieferschein"),
  allgemein: (x) => x.includes("allgemein") || x.includes("sonstig"),
};

export function documentType(cfg: Config, wanted: string): number {
  const n = norm(wanted);
  if (cfg.documentTypes[n] !== undefined) return cfg.documentTypes[n];
  const match = ALIASES[n];
  if (match) for (const k of Object.keys(cfg.documentTypes)) if (match(k)) return cfg.documentTypes[k];
  throw new InputError(`Dokumenttyp "${wanted}" gibt es in diesem HERO-Konto nicht. Verfügbar: ${cfg.documentTypeNames.join(", ")}`);
}

const invoiceTypeIds = (cfg: Config) => [
  ...new Set(Object.entries(cfg.documentTypes).filter(([k]) => ALIASES.rechnung(k) || ALIASES.rechnung13b(k)).map(([, id]) => id)),
];

// ── Duplicate protection for writes ──

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DONE_TTL = 15 * 60;
const PENDING_TTL = 120;

/**
 * Run a write once. The same tool with the same arguments within 15 minutes returns the
 * first result instead of creating a second invoice, payment, … A write whose outcome
 * is unknown (timeout, HERO 5xx) blocks repeats too, until someone checked HERO.
 */
async function once(ctx: Ctx, tool: string, input: Record<string, unknown>, fn: () => Promise<unknown>) {
  const { repeat, ...args } = input;
  const key = `once:${await sha(`${ctx.url}|${tool}|${stable(args)}`)}`;
  if (!repeat) {
    const prev = await ctx.kv.get<{ pending?: boolean; result?: unknown }>(key, "json");
    if (prev?.pending)
      throw new InputError(
        "Die gleiche Anfrage wurde gerade schon gesendet und ihr Ergebnis ist unklar. Bitte zuerst in HERO (search) prüfen, ob sie angelegt wurde. Nur wenn nicht: mit repeat: true erneut senden.",
      );
    if (prev && "result" in prev)
      return { bereits_angelegt: true, hinweis: "Identische Anfrage innerhalb von 15 Minuten: nicht erneut angelegt. Für ein bewusstes zweites Exemplar repeat: true setzen.", ...(prev.result as object) };
  }
  await ctx.kv.put(key, JSON.stringify({ pending: true }), { expirationTtl: PENDING_TTL });
  try {
    const result = await fn();
    await ctx.kv.put(key, JSON.stringify({ result }), { expirationTtl: DONE_TTL });
    console.log(`write ok: ${tool} by ${ctx.user}`);
    return result;
  } catch (e) {
    // Refused by HERO or by our own checks: nothing was created, so a retry is fine.
    if (e instanceof InputError || (e instanceof HeroError && e.status === 422)) await ctx.kv.delete(key);
    throw e;
  }
}

// ── Shared input pieces ──

const UNITS = ["Stk", "Std", "lfm", "m", "m²", "m³", "h", "kg", "g", "ml", "cm", "mm", "km", "Tag", "Woche", "Satz", "Paar", "Set", "Sack", "%"];
const UNIT_ALIASES: Record<string, string> = {
  pauschal: "Satz",
  psch: "Satz",
  pausch: "Satz",
  stueck: "Stk",
  stk: "Stk",
  st: "Stk",
  stunde: "Std",
  stunden: "Std",
  qm: "m²",
  m2: "m²",
  m3: "m³",
  cbm: "m³",
  lfdm: "lfm",
  laufmeter: "lfm",
  tage: "Tag",
  wochen: "Woche",
};

export function unit(raw: string): string {
  const exact = UNITS.find((u) => u.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const alias = UNIT_ALIASES[norm(raw)];
  if (alias) return alias;
  throw new InputError(`Einheit "${raw}" gibt es bei HERO nicht. Erlaubt: ${UNITS.join(" ")} ("pauschal" heißt bei HERO "Satz").`);
}

const position = z.object({
  name: z.string().min(1).describe("Positionsbezeichnung"),
  unit: z.string().describe(`Einheit: ${UNITS.join(" ")}`),
  quantity: z.number(),
  unit_price: z.number().describe("Netto-Einzelpreis in EUR. Negativ nur für Abzüge (z. B. bereits berechnete Abschläge)."),
  description: z.string().optional().describe("Langtext"),
  vat_percent: z.number().min(0).max(100).default(19),
});

const positions = z.array(position).min(1).max(300);
const repeatArg = z.boolean().optional().describe("Nur setzen, wenn bewusst ein zweites identisches Exemplar angelegt werden soll.");
const publishArg = z
  .boolean()
  .default(false)
  .describe("false (Standard) = Entwurf, den ein Mensch in HERO prüft und finalisiert. true = sofort final mit Nummer; nur wenn ausdrücklich gewünscht.");
const isoOffset = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/, "ISO-Zeit MIT Offset, z. B. 2026-11-03T08:00:00+01:00 (ohne Offset antwortet HERO mit Serverfehler)");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als YYYY-MM-DD");
const id = z.number().int().positive();

const buildPositions = (list: z.infer<typeof positions>) =>
  list.map((p) => ({
    add_product_position: {
      name: p.name,
      description: p.description ?? "",
      unit_type: unit(p.unit),
      quantity: p.quantity,
      net_price: p.unit_price,
      vat_percent: p.vat_percent,
    },
  }));

async function recipientFor(ctx: Ctx, projectMatchId: number) {
  const d = await ctx.hero.query(
    `query ($i: Int) { project_match(project_match_id: $i) { id customer { title first_name last_name company_name address { street zipcode city } } } }`,
    { i: projectMatchId },
  );
  const c = d.project_match?.customer;
  if (!c) throw new InputError(`Projekt ${projectMatchId} nicht gefunden oder ohne Kunde.`);
  return {
    company_name: c.company_name ?? "",
    title: c.title ?? "",
    first_name: c.first_name ?? "",
    last_name: c.last_name ?? "",
    street: c.address?.street ?? "",
    zipcode: c.address?.zipcode ?? "",
    city: c.address?.city ?? "",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createDocument(ctx: Ctx, typeId: number, projectMatchId: number, actions: object[], publish: boolean) {
  const r = await ctx.hero.mutate(
    `mutation ($i: Documents_CreateDocumentInput!, $a: [Documents_DocumentBuilderActionInput!]!) {
       create_document(input: $i, actions: $a) { customer_document_id } }`,
    { i: { document_type_id: typeId, project_match_id: projectMatchId, publish }, a: actions },
  );
  const docId = r.create_document?.customer_document_id;
  if (!docId) throw new HeroError("HERO hat kein Dokument zurückgegeben.");
  let doc: any = null;
  // Publishing runs asynchronously in HERO; wait briefly for number and PDF.
  for (let attempt = 0; attempt < (publish ? 3 : 1); attempt++) {
    await sleep(attempt === 0 ? 800 : 2500);
    const d = await ctx.hero.query(
      `query ($i: [Int]) { customer_documents(ids: $i, first: 1) { id nr type value vat date status_code status_name file_upload { uuid filename } } }`,
      { i: [docId] },
    );
    doc = d.customer_documents?.[0] ?? doc;
    if (!publish || doc?.file_upload?.uuid) break;
  }
  return {
    document_id: docId,
    entwurf: !publish,
    nr: doc?.nr ?? null,
    netto: doc?.value ?? null,
    mwst: doc?.vat ?? null,
    status: doc?.status_name ?? null,
    hinweis: publish
      ? doc?.file_upload?.uuid
        ? "Final. PDF-Link über file_link."
        : "Final; HERO erzeugt das PDF noch. In ein paar Sekunden file_link aufrufen."
      : "Entwurf in HERO angelegt. Bitte dort prüfen und finalisieren; dieser Server ändert bestehende Dokumente nicht.",
  };
}

const money = (n: number) => Math.round(n * 100) / 100;

// ── Tools ──

export function registerBusinessTools(server: McpServer, ctx: Ctx, run: Run) {
  const read = { readOnlyHint: true, openWorldHint: false };
  const create = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const reg = (name: string, description: string, inputSchema: Record<string, z.ZodType>, annotations: object, fn: (a: any) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema, annotations }, ((a: any) => run(() => fn(a))) as any);

  // Reads

  reg(
    "search",
    "Universalsuche über Kontakte, Projekte, Dokumente und Aufträge in einem Aufruf. Erster Griff, wenn nur ein Name, eine Nummer oder ein Stichwort bekannt ist.",
    { term: z.string().min(2).max(200) },
    read,
    async ({ term }) => {
      const d = await ctx.hero.query(
        `query ($t: String) {
           kontakte: global_search(category: contacts, term: $t, first: 8) { ... on Customer { id full_name company_name email phone_mobile } }
           projekte: global_search(category: project_matches, term: $t, first: 8) { ... on ProjectMatch { id project_nr name current_project_match_status { name } } }
           dokumente: global_search(category: documents, term: $t, first: 8) { ... on CustomerDocument { id nr type value date status_name project_match_id } }
           auftraege: global_search(category: jobs, term: $t, first: 8) { ... on FieldService_Job { id display_nr title status_name start } } }`,
        { t: term },
      );
      return d;
    },
  );

  reg(
    "open_items",
    "Offene Posten (Debitoren): alle Rechnungen mit Restbetrag, vollständig über alle Seiten, sortiert nach Überfälligkeit. Restbetrag = Rechnungswert minus erfasste Zahlungen.",
    { overdue_only: z.boolean().default(false), as_of: day.optional().describe("Stichtag, Standard heute") },
    read,
    async ({ overdue_only, as_of }) => {
      const cfg = await config(ctx);
      const types = invoiceTypeIds(cfg);
      if (!types.length) throw new InputError(`Kein Rechnungs-Dokumenttyp gefunden. Vorhanden: ${cfg.documentTypeNames.join(", ")}`);
      const schema = await ctx.hero.schema();
      const offsetArg = argName(schema, "customer_documents", ["offset", "skip"]);
      const PAGE = 200;
      const MAX_PAGES = 50;
      const all: any[] = [];
      let complete = false;
      for (let page = 0; page < (offsetArg ? MAX_PAGES : 1); page++) {
        const d = await ctx.hero.query(
          `query ($t: [Int], $n: Int${offsetArg ? ", $o: Int" : ""}) {
             customer_documents(document_type_ids: $t, first: $n${offsetArg ? `, ${offsetArg}: $o` : ""}, orderBy: "date desc") {
               id nr value date status_code status_name project_match_id
               contact { id full_name company_name email }
               customer_document_booking { is_open due_date payments { value paid_date } } } }`,
          { t: types, n: PAGE, ...(offsetArg ? { o: page * PAGE } : {}) },
        );
        const batch = (d.customer_documents ?? []) as any[];
        all.push(...batch);
        if (batch.length < PAGE) {
          complete = true;
          break;
        }
      }
      const today = as_of ? new Date(`${as_of}T00:00:00Z`) : new Date();
      const posten = all
        .filter((r) => r.status_code !== 1000) // 1000 = gelöscht
        .map((r) => {
          const b = r.customer_document_booking;
          const paid = ((b?.payments ?? []) as any[]).reduce((s, p) => s + (p.value ?? 0), 0);
          const rest = money((r.value ?? 0) - paid);
          const due = b?.due_date ?? null;
          return {
            document_id: r.id,
            nr: r.nr,
            project_match_id: r.project_match_id,
            kunde: r.contact?.company_name || r.contact?.full_name || null,
            email: r.contact?.email ?? null,
            datum: r.date,
            betrag: r.value,
            bezahlt: money(paid),
            restbetrag: rest,
            faellig_am: due,
            tage_ueberfaellig: due ? Math.floor((today.getTime() - new Date(due).getTime()) / 864e5) : null,
            ist_offen: b?.is_open ?? rest > 0,
          };
        })
        .filter((r) => r.ist_offen && r.restbetrag > 0.005)
        .filter((r) => !overdue_only || (r.tage_ueberfaellig ?? -1) > 0)
        .sort((a, b) => (b.tage_ueberfaellig ?? -1e9) - (a.tage_ueberfaellig ?? -1e9));
      return {
        stichtag: today.toISOString().slice(0, 10),
        vollstaendig: complete,
        ...(complete ? {} : { warnung: `Nur die neuesten ${all.length} Rechnungen geprüft; ältere offene Posten können fehlen.` }),
        anzahl: posten.length,
        summe: money(posten.reduce((s, r) => s + r.restbetrag, 0)),
        posten: posten.slice(0, 150),
      };
    },
  );

  reg(
    "payment_status",
    "Zahlungsstatus einer Rechnung: offen oder bezahlt, Restbetrag, Fälligkeit und die erfassten Zahlungen.",
    { document_id: id },
    read,
    async ({ document_id }) => {
      const d = await ctx.hero.query(
        `query ($i: [Int]) { customer_documents(ids: $i, first: 1) {
           id nr type value vat date status_name contact { id full_name company_name }
           customer_document_booking { is_open status_name due_date paid_date payments { id value paid_date } } } }`,
        { i: [document_id] },
      );
      const doc = d.customer_documents?.[0];
      if (!doc) throw new InputError(`Dokument ${document_id} nicht gefunden.`);
      const b = doc.customer_document_booking;
      const paid = ((b?.payments ?? []) as any[]).reduce((s, p) => s + (p.value ?? 0), 0);
      return {
        document_id: doc.id,
        nr: doc.nr,
        kunde: doc.contact?.company_name || doc.contact?.full_name || null,
        betrag: doc.value,
        bezahlt: money(paid),
        restbetrag: money((doc.value ?? 0) - paid),
        ist_offen: b?.is_open ?? null,
        faellig_am: b?.due_date ?? null,
        status: b?.status_name ?? doc.status_name,
        zahlungen: b?.payments ?? [],
        ...(b ? {} : { hinweis: "Kein Buchungssatz: Dokument ist nicht zahlungsrelevant (z. B. Angebot oder Entwurf)." }),
      };
    },
  );

  reg(
    "get_checklists",
    "Checklisten eines Auftrags inklusive der vor Ort in der HERO-App ausgefüllten Antworten (Feld data).",
    { job_id: id },
    read,
    async ({ job_id }) => {
      const d = await ctx.hero.query(
        `query ($j: Int) { job_checklists(job_id: $j, first: 50) { id name status data created modified partner { id full_name } } }`,
        { j: job_id },
      );
      return { checklisten: d.job_checklists ?? [] };
    },
  );

  reg(
    "file_link",
    "Zeitlich begrenzter Download-Link: für ein Dokument (document_id) oder eine beliebige Datei (file_upload_uuid, z. B. aus get_project oder get_receipt). Der Link braucht keinen Token.",
    {
      document_id: id.optional(),
      file_upload_uuid: z.string().regex(/^[\w-]{8,64}$/).optional(),
      minutes: z.number().int().min(1).max(1440).default(10),
    },
    read,
    async ({ document_id, file_upload_uuid, minutes }) => {
      if (Boolean(document_id) === Boolean(file_upload_uuid)) throw new InputError("Genau eins angeben: document_id ODER file_upload_uuid.");
      let uuid = file_upload_uuid as string | undefined;
      if (document_id) {
        const d = await ctx.hero.query(`query ($i: [Int]) { customer_documents(ids: $i, first: 1) { id nr status_name file_upload { uuid } } }`, {
          i: [document_id],
        });
        const doc = d.customer_documents?.[0];
        if (!doc) throw new InputError(`Dokument ${document_id} nicht gefunden.`);
        uuid = doc.file_upload?.uuid;
        if (!uuid) throw new InputError(`Dokument ${doc.nr ?? document_id} hat noch kein PDF (Status: ${doc.status_name}). Entwürfe haben keine Datei.`);
      }
      const f = await ctx.hero.query(`query ($u: [String!], $s: Int) { file_uploads(uuids: $u, first: 1) { uuid filename type size temporary_url(expires: $s) } }`, {
        u: [uuid],
        s: minutes * 60,
      });
      const file = f.file_uploads?.[0];
      if (!file) throw new InputError(`Datei ${uuid} nicht gefunden.`);
      return { filename: file.filename, typ: file.type, groesse: file.size, url: file.temporary_url, gueltig_minuten: minutes };
    },
  );

  // Writes: create only. Nothing here edits or deletes existing data.

  reg(
    "create_customer",
    "Kontakt mit Adresse anlegen. HERO prüft auf Dubletten: ein bereits vorhandener Kontakt wird zurückgegeben statt doppelt angelegt.",
    {
      email: z.string().email(),
      first_name: z.string().min(1),
      last_name: z.string().min(1),
      street: z.string().min(1),
      zip_code: z.string().regex(/^\d{5}$/, "Deutsche PLZ mit 5 Ziffern (eine 4-stellige PLZ legt HERO als Schweiz an)"),
      city: z.string().min(1),
      salutation: z.enum(["Herr", "Frau", "Divers", "Firma"]).optional(),
      company: z.string().optional(),
      phone: z.string().optional(),
      repeat: repeatArg,
    },
    create,
    (a) =>
      once(ctx, "create_customer", a, async () => {
        const contact: Record<string, unknown> = {
          email: a.email,
          first_name: a.first_name,
          last_name: a.last_name,
          category: "customer",
          address: { street: a.street, zipcode: a.zip_code, city: a.city },
        };
        if (a.salutation) contact.title = a.salutation;
        if (a.company) contact.company_name = a.company;
        if (a.phone) contact.phone_mobile = a.phone;
        const d = await ctx.hero.mutate(
          `mutation ($c: CustomerInput) { create_contact(findExisting: true, contact: $c) { id nr email full_name company_name address_id } }`,
          { c: contact },
        );
        return d.create_contact;
      }),
  );

  reg(
    "create_project",
    "Projekt für einen Kunden anlegen. Startet auf der ersten Projektstufe. Achtung: Projekte lassen sich in HERO nicht löschen.",
    { customer_id: id, name: z.string().min(1).max(200), repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "create_project", a, async () => {
        const cfg = await config(ctx);
        const c = await ctx.hero.query(`query ($i: [Int]) { contacts(ids: $i, first: 1) { id address_id full_name } }`, { i: [a.customer_id] });
        const kunde = c.contacts?.[0];
        if (!kunde) throw new InputError(`Kontakt ${a.customer_id} nicht gefunden.`);
        if (!kunde.address_id) throw new InputError(`Kontakt ${a.customer_id} hat keine Adresse; HERO braucht eine für das Projekt.`);
        const pm: Record<string, unknown> = { customer_id: a.customer_id, address_id: kunde.address_id, name: a.name };
        if (cfg.projectTypeId) pm.type_id = cfg.projectTypeId;
        if (cfg.measureId) pm.measure_id = cfg.measureId;
        const d = await ctx.hero.mutate(
          `mutation ($pm: ProjectMatchInput) { create_project_match(project_match: $pm) { id project_nr name current_project_match_status { name } } }`,
          { pm },
        );
        const p = d.create_project_match;
        return { project_match_id: p?.id, project_nr: p?.project_nr, name: p?.name, stufe: p?.current_project_match_status?.name ?? null, kunde: kunde.full_name };
      }),
  );

  reg(
    "create_offer",
    "Angebot anlegen, standardmäßig als ENTWURF. Empfänger kommt aus dem Projekt. Ein final veröffentlichtes Angebot setzt das Projekt in HERO auf 'Angebot verschickt'.",
    {
      project_match_id: id,
      positions,
      title: z.string().max(200).optional(),
      intro: z.string().max(4000).optional(),
      discount_percent: z.number().min(0).max(100).optional(),
      publish: publishArg,
      repeat: repeatArg,
    },
    create,
    (a) =>
      once(ctx, "create_offer", a, async () => {
        const cfg = await config(ctx);
        const actions: object[] = [{ set_recipient: await recipientFor(ctx, a.project_match_id) }];
        if (a.title) actions.push({ add_title: { text: a.title, tier: 0 } });
        if (a.intro) actions.push({ add_text: { text: a.intro } });
        actions.push(...buildPositions(a.positions));
        if (a.discount_percent) actions.push({ set_document_discount: { valueType: "PERCENT", value: a.discount_percent, label: "Nachlass" } });
        return createDocument(ctx, documentType(cfg, "angebot"), a.project_match_id, actions, a.publish);
      }),
  );

  reg(
    "create_document",
    "Dokument anlegen, standardmäßig als ENTWURF: rechnung, rechnung_13b, gutschrift, auftragsbestaetigung, lieferschein, allgemein oder ein Dokumenttyp-Name dieses Kontos. Abschlags- und Schlussrechnungen sind 'rechnung'; bei der Schlussrechnung jeden bereits berechneten Abschlag als eigene negative Position mit Rechnungsnummer aufführen.",
    {
      project_match_id: id,
      doc_type: z.string().min(2),
      positions,
      title: z.string().max(200).optional(),
      intro: z.string().max(4000).optional(),
      publish: publishArg,
      repeat: repeatArg,
    },
    create,
    (a) =>
      once(ctx, "create_document", a, async () => {
        const cfg = await config(ctx);
        const actions: object[] = [{ set_recipient: await recipientFor(ctx, a.project_match_id) }];
        if (a.title) actions.push({ add_title: { text: a.title, tier: 0 } });
        if (a.intro) actions.push({ add_text: { text: a.intro } });
        actions.push(...buildPositions(a.positions));
        return createDocument(ctx, documentType(cfg, a.doc_type), a.project_match_id, actions, a.publish);
      }),
  );

  reg(
    "create_invoice_from_offer",
    "Rechnung mit exakt den Positionen eines veröffentlichten Angebots (centgenau, mit Verweis auf das Angebot), standardmäßig als ENTWURF.",
    { offer_document_id: id, project_match_id: id, publish: publishArg, repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "create_invoice_from_offer", a, async () => {
        const cfg = await config(ctx);
        const d = await ctx.hero.query(`query ($i: [Int]) { customer_documents(ids: $i, first: 1) { id nr published_customer_document_draft { data } } }`, {
          i: [a.offer_document_id],
        });
        const doc = d.customer_documents?.[0];
        if (!doc) throw new InputError(`Angebot ${a.offer_document_id} nicht gefunden.`);
        const data = doc.published_customer_document_draft?.data;
        if (!data) throw new InputError(`Angebot ${doc.nr ?? a.offer_document_id} ist noch nicht veröffentlicht; erst in HERO finalisieren.`);
        const uids: string[] = [];
        (function walk(o: unknown) {
          if (Array.isArray(o)) return o.forEach(walk);
          if (o && typeof o === "object") {
            const r = o as Record<string, unknown>;
            if (r.type === "product" && typeof r.uid === "string") uids.push(r.uid);
            Object.values(r).forEach(walk);
          }
        })(typeof data === "string" ? JSON.parse(data) : data);
        if (!uids.length) throw new InputError(`Angebot ${doc.nr} enthält keine übernehmbaren Positionen.`);
        const actions = [
          { set_recipient: await recipientFor(ctx, a.project_match_id) },
          { add_positions_from_document: { documentId: a.offer_document_id, selectedPositions: uids, flowType: "copy", fixedItemNumbers: true } },
          { set_reference_documents: { referenceDocumentIds: [a.offer_document_id], referenceDocuments: doc.nr } },
        ];
        return createDocument(ctx, documentType(cfg, "rechnung"), a.project_match_id, actions, a.publish);
      }),
  );

  reg(
    "create_timesheet",
    "Stundenzettel aus den erfassten Zeiten eines Projekts (Dokumenttyp 'allgemein', eine Zeile pro Zeiteintrag), standardmäßig als ENTWURF.",
    { project_match_id: id, date_from: day.optional(), date_to: day.optional(), title: z.string().max(200).default("Stundenzettel"), publish: publishArg, repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "create_timesheet", a, async () => {
        const cfg = await config(ctx);
        const d = await ctx.hero.query(
          `query ($p: Int, $s: Date, $e: Date) { tracking_times(project_match_id: $p, start: $s, end: $e, first: 500, show_all_partners: true, orderBy: "start asc") {
             id start duration_in_seconds comment partner { full_name } } }`,
          { p: a.project_match_id, s: a.date_from ?? null, e: a.date_to ?? null },
        );
        const times = (d.tracking_times ?? []) as any[];
        if (!times.length) throw new InputError("Im Zeitraum sind keine Zeiten erfasst.");
        const hours = (s: number) => money((s ?? 0) / 3600);
        const total = hours(times.reduce((s, t) => s + (t.duration_in_seconds ?? 0), 0));
        const actions: object[] = [
          { set_recipient: await recipientFor(ctx, a.project_match_id) },
          { add_title: { text: a.title, tier: 0 } },
          { add_text: { text: `Erfasste Zeiten${a.date_from ? ` vom ${a.date_from}` : ""}${a.date_to ? ` bis ${a.date_to}` : ""}: ${total} Stunden.` } },
          ...times.map((t) => ({
            add_product_position: {
              name: `${String(t.start ?? "").slice(0, 10)}${t.partner?.full_name ? ` · ${t.partner.full_name}` : ""}`,
              description: t.comment ?? "",
              unit_type: "Std",
              quantity: hours(t.duration_in_seconds),
              net_price: 0,
              vat_percent: 19,
            },
          })),
        ];
        const res = await createDocument(ctx, documentType(cfg, "allgemein"), a.project_match_id, actions, a.publish);
        return { ...res, eintraege: times.length, summe_stunden: total };
      }),
  );

  reg(
    "create_job",
    "Field-Service-Auftrag (Wartung, Reparatur, Notdienst) anlegen und dem angemeldeten HERO-Nutzer zuweisen.",
    {
      customer_id: id,
      title: z.string().min(1).max(200),
      start: isoOffset,
      end: isoOffset,
      job_type: z.enum(["maintenance", "repair", "emergency", "other"]).default("maintenance"),
      project_match_id: id.optional(),
      description: z.string().max(4000).optional(),
      repeat: repeatArg,
    },
    create,
    (a) =>
      once(ctx, "create_job", a, async () => {
        const cfg = await config(ctx);
        const job: Record<string, unknown> = { customer_id: a.customer_id, title: a.title, type: a.job_type, description: a.description ?? "", start: a.start, end: a.end };
        if (a.project_match_id) job.project_match_id = a.project_match_id;
        if (cfg.partnerId) job.partners = [cfg.partnerId];
        const d = await ctx.hero.mutate(
          `mutation ($j: FieldService_JobInput) { create_field_service_job(job: $j) { id display_nr title type status_name start end project_match_id } }`,
          { j: job },
        );
        return d.create_field_service_job;
      }),
  );

  reg(
    "create_checklist",
    "Checkliste an einen Auftrag ODER ein Projekt hängen. Abgehakt wird in der HERO-App.",
    {
      name: z.string().min(1).max(200),
      items: z
        .array(
          z.object({
            label: z.string().min(1),
            type: z.enum(["checkbox", "text", "image", "signature", "select"]).default("checkbox"),
            options: z.array(z.string()).optional(),
            multiple: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(100),
      job_id: id.optional(),
      project_match_id: id.optional(),
      repeat: repeatArg,
    },
    create,
    (a) =>
      once(ctx, "create_checklist", a, async () => {
        if (Boolean(a.job_id) === Boolean(a.project_match_id)) throw new InputError("Genau eins angeben: job_id ODER project_match_id.");
        const entries = (a.items as any[]).map((it) => {
          const e: Record<string, unknown> = { type: it.type, label: it.label };
          if (it.type === "select") {
            e.options = it.options ?? [];
            e.multiple = Boolean(it.multiple);
          }
          if (it.type === "image") e.multiple = Boolean(it.multiple);
          return e;
        });
        const d = await ctx.hero.mutate(
          `mutation ($jid: Int, $pm: Int, $c: FieldService_ChecklistInput) {
             create_field_service_checklist(job_id: $jid, project_match_id: $pm, checklist: $c) { id name data status } }`,
          { jid: a.job_id ?? null, pm: a.project_match_id ?? null, c: { name: a.name, data: { entries } } },
        );
        const cl = d.create_field_service_checklist;
        const saved = cl?.data?.entries?.length ?? 0;
        if (saved !== entries.length)
          return { ...cl, warnung: `HERO hat nur ${saved} von ${entries.length} Punkten gespeichert. Bitte die Checkliste in HERO prüfen.` };
        return cl;
      }),
  );

  reg(
    "create_article",
    "Artikel im Artikelstamm anlegen. Setzt den Verkaufspreis ausdrücklich, sonst kalkuliert HERO Angebote zum Einkaufspreis.",
    {
      nr: z.string().min(1).max(64),
      name: z.string().min(1).max(200),
      unit: z.string(),
      purchase_price: z.number().min(0).describe("Einkaufspreis netto"),
      sale_price: z.number().min(0).describe("Verkaufspreis netto"),
      vat_percent: z.number().min(0).max(100).default(19),
      description: z.string().optional(),
      manufacturer: z.string().optional(),
      ean: z.string().optional(),
      repeat: repeatArg,
    },
    create,
    (a) =>
      once(ctx, "create_article", a, async () => {
        if (a.sale_price < a.purchase_price) throw new InputError("Verkaufspreis liegt unter dem Einkaufspreis. Bitte prüfen.");
        const d = await ctx.hero.mutate(
          `mutation ($p: Documents_SupplyProductVersionInput!) {
             create_supply_product_version(supply_product_version: $p) { product_id nr base_price list_price vat_percent base_data { name unit_type } } }`,
          {
            p: {
              nr: a.nr,
              base_price: a.purchase_price,
              list_price: a.sale_price,
              vat_percent: a.vat_percent,
              price_quantity: 1,
              default_sales_price: a.sale_price,
              sales_prices: [{ net_price_per_unit: a.sale_price, label: "VK" }],
              base_data: {
                name: a.name,
                description: a.description ?? "",
                ean: a.ean ?? "",
                unit_type: unit(a.unit),
                manufacturer: a.manufacturer ?? "",
                matchcode: a.name.toUpperCase().slice(0, 40),
              },
            },
          },
        );
        return d.create_supply_product_version;
      }),
  );

  reg(
    "schedule_appointment",
    "Termin an einem Projekt anlegen. category ist der Name einer Terminkategorie dieses HERO-Kontos.",
    { project_match_id: id, title: z.string().min(1).max(200), start: isoOffset, end: isoOffset, category: z.string().optional(), repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "schedule_appointment", a, async () => {
        const cfg = await config(ctx);
        let category: number | null = null;
        if (a.category) {
          category = cfg.calendarCategories[norm(a.category)] ?? null;
          if (category === null) throw new InputError(`Terminkategorie "${a.category}" unbekannt. Verfügbar: ${Object.keys(cfg.calendarCategories).join(", ")}`);
        }
        const event: Record<string, unknown> = { project_match_id: a.project_match_id, title: a.title, start: a.start, end: a.end, all_day: false };
        if (category !== null) event.category_id = category;
        if (cfg.partnerId) event.partner_ids = [cfg.partnerId];
        const d = await ctx.hero.mutate(
          `mutation ($e: CalendarEventInput) { create_calendar_event(calendar_event: $e) { id title start end category { name } } }`,
          { e: event },
        );
        return d.create_calendar_event;
      }),
  );

  reg(
    "add_task",
    "Aufgabe an einem Projekt anlegen (nur neu anlegen, nie bestehende ändern).",
    { project_match_id: id, title: z.string().min(1).max(200), due: isoOffset, comment: z.string().max(4000).optional(), repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "add_task", a, async () => {
        const d = await ctx.hero.mutate(`mutation ($t: TaskInput) { update_task(task: $t) { id title comment due_date target_project_match_id } }`, {
          t: { title: a.title, comment: a.comment ?? "", due_date: a.due, target_project_match_id: a.project_match_id },
        });
        return d.update_task;
      }),
  );

  reg(
    "log_time",
    "Arbeitszeit auf ein Projekt buchen (nur neu anlegen). Die Dauer rechnet HERO selbst.",
    { project_match_id: id, start: isoOffset, end: isoOffset, comment: z.string().max(2000).optional(), repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "log_time", a, async () => {
        if (new Date(a.end) <= new Date(a.start)) throw new InputError("Ende muss nach dem Beginn liegen.");
        const cfg = await config(ctx);
        const t: Record<string, unknown> = { project_match_id: a.project_match_id, start: a.start, end: a.end, comment: a.comment ?? "" };
        if (cfg.partnerId) t.partner_id = cfg.partnerId;
        const d = await ctx.hero.mutate(
          `mutation ($t: Employees_TrackingTimeInput) { update_tracking_time(tracking_time: $t) { id start end duration_in_seconds comment } }`,
          { t },
        );
        return d.update_tracking_time;
      }),
  );

  reg(
    "add_logbook_note",
    "Logbucheintrag am Projekt anlegen. Der Eintrag wird mit dem Namen der angemeldeten Person gekennzeichnet.",
    { project_match_id: id, text: z.string().min(1).max(4000), repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "add_logbook_note", a, async () => {
        const d = await ctx.hero.mutate(`mutation ($l: LogbookEntryInput!) { add_logbook_entry(logbook_entry: $l) { id created } }`, {
          l: { target: "project_match", target_id: a.project_match_id, custom_text: `${a.text}\n— via Claude (${ctx.user})` },
        });
        return d.add_logbook_entry;
      }),
  );

  reg(
    "record_payment",
    "Zahlungseingang auf eine Rechnung erfassen und danach den Zahlungsstand zurücklesen.",
    { document_id: id, amount: z.number().positive().describe("Betrag brutto in EUR"), date: day, repeat: repeatArg },
    create,
    (a) =>
      once(ctx, "record_payment", a, async () => {
        const before = await ctx.hero.query(
          `query ($i: [Int]) { customer_documents(ids: $i, first: 1) { id nr value customer_document_booking { payments { value } } } }`,
          { i: [a.document_id] },
        );
        const doc = before.customer_documents?.[0];
        if (!doc) throw new InputError(`Dokument ${a.document_id} nicht gefunden.`);
        if (!doc.customer_document_booking) throw new InputError(`Dokument ${doc.nr ?? a.document_id} ist nicht zahlungsrelevant (Entwurf oder kein Rechnungstyp).`);
        const paid = ((doc.customer_document_booking.payments ?? []) as any[]).reduce((s, p) => s + (p.value ?? 0), 0);
        const rest = money((doc.value ?? 0) - paid);
        if (a.amount > rest + 0.005) throw new InputError(`Betrag ${a.amount} ist höher als der offene Restbetrag ${rest}. Bitte prüfen.`);
        await ctx.hero.mutate(`mutation ($d: Int!, $p: PaymentInput!) { create_payment(document_id: $d, payment: $p) { id } }`, {
          d: a.document_id,
          p: { paid_date: a.date, value: a.amount },
        });
        await sleep(800);
        const after = await ctx.hero.query(
          `query ($i: [Int]) { customer_documents(ids: $i, first: 1) { value customer_document_booking { is_open payments { value paid_date } } } }`,
          { i: [a.document_id] },
        );
        const b = after.customer_documents?.[0]?.customer_document_booking;
        const total = ((b?.payments ?? []) as any[]).reduce((s, p) => s + (p.value ?? 0), 0);
        return { nr: doc.nr, erfasst: a.amount, bezahlt_gesamt: money(total), restbetrag: money((doc.value ?? 0) - total), ist_offen: b?.is_open ?? null };
      }),
  );
}
