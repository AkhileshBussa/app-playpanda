/**
 * One-time Google Sheets setup for the membership mirror: creates the
 * "Memberships" and "Visits" tabs (if missing) and writes their header rows.
 *
 * Run after filling the GOOGLE_SHEETS_* vars in .env.local:
 *   npx tsx scripts/setup-sheets.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.local (next dev does this automatically; plain tsx doesn't).
try {
  const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
} catch {
  // No .env.local — rely on the shell environment.
}

async function main() {
  const { setupSheetTabs } = await import("../src/lib/members/sheets");
  const log = await setupSheetTabs();
  for (const line of log) console.log("✓", line);
  console.log("Sheets mirror is ready.");
}

main().catch((err) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
