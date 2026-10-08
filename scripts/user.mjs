// Manage access codes: npm run user -- add "Anna Muster" | remove "Anna Muster" | list
// Talks to the deployed KV namespace; set HERO_MCP_LOCAL=1 to use local dev storage instead.
// Each code is one KV key "user:<sha256 of code>" holding the name (also as metadata, so a list shows it).
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const where = process.env.HERO_MCP_LOCAL ? "--local" : "--remote";

// Runs wrangler through node itself: works on Windows too, and any wrangler error stops the script.
const kv = (...args) =>
  execFileSync(process.execPath, [wrangler, "kv", "key", ...args, "--binding=OAUTH_KV", where], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

function users() {
  return JSON.parse(kv("list", "--prefix=user:")).map((k) => ({ key: k.name, name: k.metadata?.name ?? kv("get", k.name, "--text").trim() }));
}

// Every key of this person, so an old code can never survive an add or a remove.
const keysOf = (name) => users().filter((u) => u.name.toLowerCase() === name.toLowerCase());

const [cmd, ...rest] = process.argv.slice(2);
const name = rest.join(" ").trim();

if (cmd === "list") {
  console.log(users().map((u) => u.name).sort().join("\n") || "(no users)");
} else if (cmd === "add" && name) {
  const old = keysOf(name);
  const code = randomBytes(16).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  kv("put", `user:${hash}`, name, `--metadata=${JSON.stringify({ name })}`);
  for (const u of old) kv("delete", u.key);
  console.log(`Access code for ${name} (shown once, send it privately):\n\n    ${code}\n`);
  if (old.length) console.log("Their previous code no longer works.");
} else if (cmd === "remove" && name) {
  const old = keysOf(name);
  if (!old.length) {
    console.log(`No such user: ${name}`);
    process.exit(1);
  }
  for (const u of old) kv("delete", u.key);
  console.log(`Removed ${name}; their access stops within a minute.`);
} else {
  console.log('usage: npm run user -- add "NAME" | remove "NAME" | list');
  process.exit(2);
}
