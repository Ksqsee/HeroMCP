# hero-mcp

An MCP server that lets Claude work in [HERO Software](https://hero-software.de)
(Handwerkersoftware): look things up, and **create** customers, projects, offers,
invoices, appointments, tasks, time entries and payments. It runs as a Cloudflare
Worker on HERO's newest GraphQL API (**v9**), and colleagues connect it in Claude as
a connector.

**Claude can create, but never edit or delete.** Every write passes one guard
(`assertCreateOnly` in `src/hero.ts`): only an allowlist of HERO *create* mutations
gets through, `update_task` / `update_tracking_time` only without an id (HERO uses
them to create), and `graphql_query` stays read-only.

```
Claude (claude.ai / Desktop)  ──HTTPS + OAuth──▶  hero-mcp Worker (login + tools)
                                                     │  company HERO API key (secret)
                                                     ▼
                                     login.hero-software.de/api/external/v9/graphql
```

## Tools

**Read**

| Tool | What it does |
| --- | --- |
| `status` | Checks the HERO connection and shows who is signed in |
| `search` | One search over contacts, projects, documents and jobs |
| `list_contacts`, `get_contact` | Contacts with address |
| `list_projects`, `get_project` | Projects with customer, status, documents (file links) and logbook |
| `list_documents` | Offers, invoices, … with type, file and payment booking |
| `open_items` | All unpaid invoices with remaining amount and days overdue, paged through completely |
| `payment_status` | Paid / open, remaining amount and payments of one invoice |
| `list_receipts`, `get_receipt` | Incoming receipts and supplier invoices (Eingangsbelege) with their files |
| `file_link` | Time-limited download link for a document PDF or any file |
| `list_calendar_events`, `list_jobs`, `get_checklists`, `list_time_entries`, `list_products` | Appointments, field service jobs, checklist answers, tracked time, articles |
| `describe_schema`, `graphql_query` | The live HERO data model, and any read-only query |

**Create** (never edit, never delete)

| Tool | What it creates |
| --- | --- |
| `create_customer` | Contact with address (HERO returns an existing one instead of a duplicate) |
| `create_project` | Project for a customer |
| `create_offer`, `create_document`, `create_invoice_from_offer`, `create_timesheet` | Offers, invoices (incl. Abschlag/Schluss), credit notes, … **as drafts by default** |
| `create_job`, `create_checklist` | Field service job and checklist |
| `create_article` | Article with purchase *and* sales price |
| `schedule_appointment`, `add_task`, `log_time`, `add_logbook_note` | Appointment, task, time entry, logbook note (signed "via Claude (name)") |
| `record_payment` | Incoming payment on an invoice (refuses more than the open amount) |

### Safety rules for writes

- **Drafts first.** Documents are created as drafts (`publish: false`). A person
  checks and finalises them in HERO. `publish: true` exists, but only for when that
  is explicitly wanted, because a final invoice can only be fixed with a Storno.
- **No duplicates.** The same tool with the same arguments within 15 minutes returns
  the first result instead of creating a second invoice. If the outcome of a write
  is unknown (timeout, HERO 5xx), repeats are blocked until someone checked HERO.
  `repeat: true` creates a second one on purpose.
- **Checked input.** Units are mapped to HERO's list ("pauschal" → "Satz"), German
  postcodes must have 5 digits (HERO reads 4 digits as Switzerland), times need an
  offset, and sales prices below purchase prices are refused.
- **Audit.** The Worker logs which person used which write tool, never customer data.

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
- HERO's public [GraphQL guide](https://hero-software.de/api-doku/graphql-guide)
  still shows v7; v9 is the newest version the endpoint serves (v10+ return 404).
  To change versions, edit `HERO_URL` in `wrangler.jsonc`.
- The list tools read HERO's schema at runtime and skip fields that don't exist.
  The business tools use fixed v9 queries; if HERO renames a field, the tool
  reports HERO's error and nothing is created. `describe_schema` shows the live model.
- The tests run against an in-memory fake of HERO. Before relying on the write
  tools, try each one once against a HERO test account (or a test project) and
  check the result in HERO.
- File upload is not included: HERO's API can only receive files through the Lead
  API, which creates a new project for every upload.
