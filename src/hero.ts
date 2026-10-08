// Minimal read-only client for the HERO Software GraphQL API.
import { Kind, parse } from "graphql";

export class HeroError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** A mistake in the tool call that the caller can fix. */
export class InputError extends Error {}

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

interface InputValue {
  name: string;
  description?: string | null;
  type: TypeRef;
}

interface FieldDef extends InputValue {
  args: InputValue[];
}

export interface TypeDef {
  name: string;
  kind: string;
  description?: string | null;
  fields: FieldDef[] | null;
  inputFields: InputValue[] | null;
  enumValues: { name: string }[] | null;
}

export interface Schema {
  root: TypeDef;
  types: Map<string, TypeDef>;
}

/** Nested objects to include in a selection. Scalar fields are always included. */
export type Spec = { [field: string]: Spec };

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }";
// Only the query side of the schema: mutations are never looked at.
const INTROSPECTION = `query {
  __schema {
    queryType { name }
    types {
      name kind description
      fields { name description args { name description type { ${TYPE_REF} } } type { ${TYPE_REF} } }
      inputFields { name description type { ${TYPE_REF} } }
      enumValues { name }
    }
  }
}`;

const SCHEMA_TTL_MS = 10 * 60_000;
let schemaCache: { url: string; at: number; schema: Schema } | undefined;

/**
 * Throw unless the document only reads. Every request this server sends to HERO
 * passes through here, so no tool can change or delete anything.
 */
export function assertReadOnly(source: string): void {
  let doc;
  try {
    doc = parse(source);
  } catch (e) {
    throw new InputError(`Invalid GraphQL: ${(e as Error).message}`);
  }
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) continue;
    if (def.kind === Kind.OPERATION_DEFINITION && def.operation === "query") continue;
    throw new InputError("Only read queries are allowed. Mutations and subscriptions are blocked by this server.");
  }
}

export function namedType(ref: TypeRef): string {
  let r: TypeRef | null = ref;
  while (r && !r.name) r = r.ofType;
  return r?.name ?? "";
}

/** GraphQL type notation, e.g. "[Int!]!". */
export function typeString(ref: TypeRef): string {
  if (ref.kind === "NON_NULL") return `${typeString(ref.ofType!)}!`;
  if (ref.kind === "LIST") return `[${typeString(ref.ofType!)}]`;
  return ref.name ?? "";
}

export class Hero {
  constructor(
    readonly url: string,
    private apiKey: string,
  ) {}

  async query(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, any>> {
    assertReadOnly(query);
    const resp = await fetch(this.url, {
      method: "POST",
      redirect: "manual", // following a redirect would send the API key (which can also write) elsewhere
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, variables }),
    });
    if (resp.status === 401 || resp.status === 403) throw new HeroError("HERO rejected the API key (check HERO_API_KEY).", resp.status);
    if (!resp.ok) throw new HeroError(`HERO HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`, resp.status);
    const body = (await resp.json()) as { data?: Record<string, any>; errors?: { message: string }[] };
    if (body.errors?.length) throw new HeroError(`HERO: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data ?? {};
  }

  async schema(): Promise<Schema> {
    if (schemaCache && schemaCache.url === this.url && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.schema;
    const data = await this.query(INTROSPECTION);
    const types = new Map<string, TypeDef>((data.__schema.types as TypeDef[]).map((t) => [t.name, t]));
    const root = types.get(data.__schema.queryType.name);
    if (!root) throw new HeroError("HERO schema has no query type.");
    const schema = { root, types };
    schemaCache = { url: this.url, at: Date.now(), schema };
    return schema;
  }
}

export function rootField(schema: Schema, name: string): FieldDef {
  const field = schema.root.fields?.find((f) => f.name === name);
  if (!field) throw new HeroError(`This HERO account has no "${name}" query. Call describe_schema to see what exists.`);
  return field;
}

const isLeaf = (schema: Schema, ref: TypeRef) => {
  const kind = schema.types.get(namedType(ref))?.kind;
  return kind === "SCALAR" || kind === "ENUM";
};

/** All scalar fields of a type, plus the nested objects named in spec (unknown names are skipped). */
export function selection(schema: Schema, typeName: string, spec: Spec = {}): string {
  const parts: string[] = [];
  for (const f of schema.types.get(typeName)?.fields ?? []) {
    if (f.args.some((a) => a.type.kind === "NON_NULL")) continue;
    if (isLeaf(schema, f.type)) parts.push(f.name);
    else if (spec[f.name]) {
      const sub = selection(schema, namedType(f.type), spec[f.name]);
      if (sub) parts.push(`${f.name} { ${sub} }`);
    }
  }
  return parts.join(" ");
}

// Models often send numbers as strings; GraphQL is strict about Int and Float.
function coerce(ref: TypeRef, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (ref.kind === "NON_NULL") return coerce(ref.ofType!, value);
  if (ref.kind === "LIST") return (Array.isArray(value) ? value : [value]).map((v) => coerce(ref.ofType!, v));
  if ((ref.name === "Int" || ref.name === "Float") && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
    return Number(value);
  return value;
}

/** Build a query on one root field. Argument values travel as variables, never inside the query text. */
export function buildQuery(schema: Schema, fieldName: string, args: Record<string, unknown>, spec: Spec = {}) {
  const field = rootField(schema, fieldName);
  const decls: string[] = [];
  const uses: string[] = [];
  const variables: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const arg = field.args.find((a) => a.name === name);
    if (!arg)
      throw new InputError(
        `"${fieldName}" has no argument "${name}". Available: ${field.args.map((a) => `${a.name}: ${typeString(a.type)}`).join(", ") || "none"}`,
      );
    decls.push(`$${name}: ${typeString(arg.type)}`);
    uses.push(`${name}: $${name}`);
    variables[name] = coerce(arg.type, value);
  }
  const sel = isLeaf(schema, field.type) ? "" : ` { ${selection(schema, namedType(field.type), spec) || "__typename"} }`;
  const query = `query${decls.length ? `(${decls.join(", ")})` : ""} { ${fieldName}${uses.length ? `(${uses.join(", ")})` : ""}${sel} }`;
  return { query, variables };
}

/** The first of the candidate argument names that the root field accepts. */
export function argName(schema: Schema, fieldName: string, candidates: string[]): string | undefined {
  const names = new Set(rootField(schema, fieldName).args.map((a) => a.name));
  return candidates.find((c) => names.has(c));
}
