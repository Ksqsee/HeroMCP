# hero-mcp

A **read-only** MCP server that lets Claude look things up in
[HERO Software](https://hero-software.de) (Handwerkersoftware): contacts, projects,
documents, appointments and articles. It runs as a Cloudflare Worker, and colleagues
connect it in Claude as a connector. It is built the same way as
[DocuwareMCP](https://github.com/Ksqsee/DocuwareMCP)'s Worker.

**Nothing can be changed or deleted.** The server has no tools that write. Every
request it sends to HERO is checked first, and anything that is not a GraphQL
`query` (any `mutation` or `subscription`) is rejected before it leaves the Worker.

```
Claude (claude.ai / Desktop)  ──HTTPS + OAuth──▶  hero-mcp Worker (login + read-only tools)
                                                     │  company HERO API key (secret)
                                                     ▼
                                     login.hero-software.de/api/external/v7/graphql
```

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Checks the HERO connection and shows who is signed in |
| `list_contacts` | Contacts with address (`search`, `limit`, `offset`) |
| `get_contact` | One contact by id |
| `list_projects` | Projects (`project_matches`) with customer, address, trade and status |
| `get_project` | One project with its documents (file links) and logbook entries |
| `list_documents` | Customer documents (offers, invoices, …) with file links |
| `list_calendar_events` | Appointments |
| `list_products` | Article master data (`supply_product_versions`) |
| `describe_schema` | Shows the HERO data model: the read queries, their arguments and each type's fields |
| `graphql_query` | Any read-only GraphQL query, for things the tools above don't cover |

The tools read HERO's schema at runtime. They fetch every plain field of each
object, use HERO's own paging and search arguments where they exist, and pass any
extra filter through `arguments` (`describe_schema` lists the filters each query
accepts). User input always travels as GraphQL variables, never pasted into the
query text. One answer is capped at 60,000 characters, which fits what Claude
accepts from a tool. If a list is cut, ask for fewer items.

## Access

HERO gives out **one API key per company**, and that key can also write. The key
therefore only exists as a Worker secret, and colleagues never see it. Each
colleague signs in with a **personal access code** instead:

- Codes are stored only as SHA-256 hashes in Workers KV.
- Removing a person stops their access within about a minute, even for sessions
  that are already open.
- Only Claude's own callback addresses can complete a sign-in, so a look-alike app
  cannot phish a code.
- Sign-in attempts, client registrations and login-page opens are rate-limited
  per IP address, so nobody can guess codes or fill the Worker's storage.
- The API key is only ever sent to `HERO_URL`, never along a redirect, and logs
  hold only HTTP status codes, never HERO's answers.

## Deploy

You need Node 22 and a Cloudflare account. You also need a HERO API key, which you
can request from HERO support.

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV     # paste the id into wrangler.jsonc
# in wrangler.jsonc, set PUBLIC_URL to where the Worker will run (without /mcp)
npx wrangler secret put HERO_API_KEY          # paste the HERO API key
npm run deploy
```

Then, in Claude (Team/Enterprise: organization settings → **Connectors**), add a
custom connector with the URL `https://<your-worker>/mcp`. Each colleague clicks
**Connect** and enters their access code.

## Managing colleagues

```bash
npm run user -- add "Anna Muster"      # prints the access code once; send it privately
npm run user -- list
npm run user -- remove "Anna Muster"   # access ends within about a minute
```

If someone loses their code, run `add` with the same name again. This prints a new
code, and the old one stops working.

## Development

```bash
npm run check   # typecheck
npm test        # Worker tests against an in-memory fake of HERO's GraphQL API
```

## Good to know

- Everything Claude reads from HERO is sent to Anthropic. Whoever signs in sees
  everything the company's API key can read.
- The field names are taken from HERO's
  [GraphQL guide](https://hero-software.de/api-doku/graphql-guide). If HERO
  renames something, the list tools skip the missing fields instead of failing.
  `describe_schema` and `graphql_query` always show the live model.
