// Manage access codes: npm run user -- add "Anna Muster" | remove "Anna Muster" | list
// Talks to the deployed KV namespace; set HERO_MCP_LOCAL=1 to use local dev storage instead.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const where = process.env.HERO_MCP_LOCAL ? "--local" : "--remote";

function kv(...args) {
  return execFileSync("npx", ["wrangler", "kv", "key", ...args, "--binding=OAUTH_KV", where], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function get(key) {
  try {
    const value = kv("get", key, "--text").trim();
    return value && value !== "Value not found" ? value : null;
  } catch {
    return null;
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const name = rest.join(" ").trim();
const nameKey = `name:${name.toLowerCase()}`;

if (cmd === "list") {
  const keys = JSON.parse(kv("list", "--prefix=name:"));
  console.log(keys.map((k) => k.metadata?.name ?? k.name.slice(5)).sort().join("\n") || "(no users)");
} else if (cmd === "add" && name) {
  const old = get(nameKey);
  if (old) kv("delete", `user:${old}`);
  const code = randomBytes(16).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  kv("put", `user:${hash}`, name);
  kv("put", nameKey, hash, `--metadata=${JSON.stringify({ name })}`);
  console.log(`Access code for ${name} (shown once, send it privately):\n\n    ${code}\n`);
  if (old) console.log("Their previous code no longer works.");
} else if (cmd === "remove" && name) {
  const hash = get(nameKey);
  if (!hash) {
    console.log(`No such user: ${name}`);
    process.exit(1);
  }
  kv("delete", `user:${hash}`);
  kv("delete", nameKey);
  console.log(`Removed ${name}; their access stops within a minute.`);
} else {
  console.log('usage: npm run user -- add "NAME" | remove "NAME" | list');
  process.exit(2);
}
