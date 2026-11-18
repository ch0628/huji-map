import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env.local")) {
  const envText = readFileSync(".env.local", "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wddnbycimcixskemssct.supabase.co";
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

console.log("Checking remote PostgREST endpoints at:", url);

async function run() {
  const tables = ["businesses", "business_members", "business_verifications", "business_hours"];
  for (const t of tables) {
    try {
      const res = await fetch(`${url}/rest/v1/${t}?select=*`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });
      const text = await res.text();
      console.log(`[${t}] HTTP ${res.status}: ${text.slice(0, 120)}`);
    } catch (err) {
      console.error(`[${t}] Error:`, err.message);
    }
  }
}

run();

