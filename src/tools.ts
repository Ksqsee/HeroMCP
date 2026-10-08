import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { argName, buildQuery, Hero, HeroError, InputError, type Spec, typeString } from "./hero";

export interface Props {
  user: string;
  codeHash: string;
}

// Argument names HERO might use for search and paging; the live schema decides which exist.
const SEARCH_ARGS = ["search", "search_term", "searchTerm", "query", "q", "term"];
const LIMIT_ARGS = ["first", "limit", "take", "per_page"];
const OFFSET_ARGS = ["offset", "skip"];
const ID_ARGS = ["ids", "id"];

// Keeps one answer from flooding the model's context.
const MAX_OUTPUT = 200_000;

// Some clients send nested arguments as JSON strings; accept both.
const jsonArg = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);

const ok = (data: unknown) => {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n… [cut at ${MAX_OUTPUT} characters; ask for fewer items]`;
  return { content: [{ type: "text" as const, text }] };
};

// Errors the caller can fix go back as text; anything else stays generic.
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof InputError || e instanceof HeroError ? e.message : "Internal error";
    if (!(e instanceof InputError)) console.error(e);
    return { isError: true, content: [{ type: "text" as const, text: msg }] };
  }
}

interface ListTool {
  tool: string;
  field: string;
  description: string;
  spec: Spec;
}

const LISTS: ListTool[] = [
  {
    tool: "list_contacts",
    field: "contacts",
    description: "List contacts (customers, suppliers, partners) with their address.",
    spec: { address: {} },
  },
  {
    tool: "list_projects",
    field: "project_matches",
    description: "List projects with customer, contact, address, trade (measure) and current status.",
    spec: { measure: {}, customer: { address: {} }, contact: {}, address: {}, current_project_match_status: {} },
  },
  {
    tool: "list_documents",
    field: "customer_documents",
    description: "List customer documents (offers, order confirmations, invoices, …) with a link to the file.",
    spec: { file_upload: {} },
  },
  {
    tool: "list_calendar_events",
    field: "calendar_events",
    description: "List calendar appointments.",
    spec: {},
  },
  {
    tool: "list_products",
    field: "supply_product_versions",
    description: "List articles from the product master data (Artikelstamm).",
    spec: {},
  },
];

const listInput = {
  search: z.string().optional().describe("Free-text search, if HERO supports it for this list"),
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).max(100_000).default(0),
  arguments: jsonArg(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Extra HERO query arguments, e.g. filters. describe_schema shows which arguments this list accepts."),
};

async function list(
  hero: Hero,
  field: string,
  spec: Spec,
  { search, limit, offset, arguments: extra }: { search?: string; limit: number; offset: number; arguments?: Record<string, unknown> },
) {
  const schema = await hero.schema();
  const args: Record<string, unknown> = { ...extra };
  if (search !== undefined) {
    const name = argName(schema, field, SEARCH_ARGS);
    if (!name) throw new InputError(`HERO has no free-text search on "${field}". Use arguments instead; describe_schema shows the options.`);
    args[name] = search;
  }
  const first = argName(schema, field, LIMIT_ARGS);
  const skip = argName(schema, field, OFFSET_ARGS);
  const serverPaging = !!first && (!!skip || offset === 0);
  if (serverPaging) {
    args[first] = limit;
    if (skip) args[skip] = offset;
  }
  const { query, variables } = buildQuery(schema, field, args, spec);
  const result = (await hero.query(query, variables))[field];
  let items: unknown[] = Array.isArray(result) ? result : result == null ? [] : [result];
  if (!serverPaging) items = items.slice(offset, offset + limit);
  return { items, returned: items.length, limit, offset };
}

async function getOne(hero: Hero, field: string, id: string, spec: Spec) {
  const schema = await hero.schema();
  const name = argName(schema, field, ID_ARGS);
  if (!name) throw new InputError(`HERO cannot look up "${field}" by id.`);
  const { query, variables } = buildQuery(schema, field, { [name]: name === "ids" ? [id] : id }, spec);
  const result = (await hero.query(query, variables))[field];
  const item = Array.isArray(result) ? result[0] : result;
  if (!item) throw new InputError(`No ${field} entry with id ${id}.`);
  return item;
}

const idArg = z.string().regex(/^[\w-]{1,64}$/, "id must be a HERO id as returned by a list tool");

export function buildServer(url: string, apiKey: string, props: Props): McpServer {
  const hero = new Hero(url, apiKey);
  const server = new McpServer({ name: "hero", version: "1.0.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "status",
    { description: "Check the HERO connection and who is signed in.", annotations: readOnly },
    () =>
      run(async () => {
        await hero.query("query { __typename }");
        return { connected: true, user: props.user };
      }),
  );

  for (const l of LISTS) {
    server.registerTool(
      l.tool,
      {
        description: `${l.description} Read-only. Results come in pages: use limit and offset.`,
        inputSchema: listInput,
        annotations: readOnly,
      },
      (input) => run(() => list(hero, l.field, l.spec, input)),
    );
  }

  server.registerTool(
    "get_contact",
    {
      description: "Get one contact with its address.",
      inputSchema: { id: idArg },
      annotations: readOnly,
    },
    ({ id }) => run(() => getOne(hero, "contacts", id, { address: {} })),
  );

  server.registerTool(
    "get_project",
    {
      description: "Get one project with customer, address, status, its documents (with file links) and its logbook entries.",
      inputSchema: { id: idArg },
      annotations: readOnly,
    },
    ({ id }) =>
      run(() =>
        getOne(hero, "project_matches", id, {
          measure: {},
          customer: { address: {} },
          contact: {},
          address: {},
          current_project_match_status: {},
          customer_documents: { file_upload: {} },
          histories: {},
        }),
      ),
  );

  server.registerTool(
    "describe_schema",
    {
      description:
        "Explore the HERO data model. Without a type: all read queries and their arguments. With a type name: its fields (or input fields / enum values).",
      inputSchema: { type: z.string().optional().describe("Type name, e.g. ProjectMatch") },
      annotations: readOnly,
    },
    ({ type }) =>
      run(async () => {
        const schema = await hero.schema();
        if (!type)
          return {
            queries: (schema.root.fields ?? []).map((f) => ({
              name: f.name,
              returns: typeString(f.type),
              args: f.args.map((a) => `${a.name}: ${typeString(a.type)}`),
              ...(f.description ? { description: f.description } : {}),
            })),
          };
        const t = schema.types.get(type);
        if (!t || type === schema.root.name || t.name.startsWith("__")) throw new InputError(`Unknown type "${type}".`);
        const out: Record<string, unknown> = { name: t.name, kind: t.kind };
        if (t.description) out.description = t.description;
        if (t.fields) out.fields = t.fields.map((f) => ({ name: f.name, type: typeString(f.type), ...(f.description ? { description: f.description } : {}) }));
        if (t.inputFields) out.input_fields = t.inputFields.map((f) => ({ name: f.name, type: typeString(f.type) }));
        if (t.enumValues) out.values = t.enumValues.map((v) => v.name);
        return out;
      }),
  );

  server.registerTool(
    "graphql_query",
    {
      description:
        "Run a read-only GraphQL query against HERO for anything the other tools don't cover. Mutations are rejected. Use describe_schema to find fields; pass values via variables.",
      inputSchema: {
        query: z.string().max(20_000),
        variables: jsonArg(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: readOnly,
    },
    ({ query, variables }) => run(() => hero.query(query, variables ?? {})),
  );

  return server;
}
