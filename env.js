import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function uniquePaths(values) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((value) => path.resolve(value))
    ),
  ];
}

const envCandidates = uniquePaths([
  // Explicit path supplied by PM2 or the shell.
  process.env.DOTENV_CONFIG_PATH,

  // Current PM2 working directory.
  path.resolve(process.cwd(), ".env"),

  // Common backend locations.
  path.resolve(process.cwd(), "apps/api/.env"),
  path.resolve(process.cwd(), "src/.env"),

  // Locations relative to this env.js file.
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../.env"),

  // Your current production backend path.
  "/var/www/reachflybackend/.env",
]);

const loadedFiles = [];
const checkedFiles = [];

for (const envPath of envCandidates) {
  const exists = fs.existsSync(envPath);

  checkedFiles.push({
    path: envPath,
    exists,
  });

  if (!exists) {
    continue;
  }

  const result = config({
    path: envPath,
    override: false,
  });

  if (result.error) {
    console.error(
      `[startup] environment:file-error ${JSON.stringify({
        path: envPath,
        message: result.error.message,
      })}`
    );

    continue;
  }

  loadedFiles.push(envPath);
}

const googlePlacesKey = String(
  process.env.GOOGLE_PLACES_API_KEY || ""
).trim();

const dailyAutomationEnabled =
  String(
    process.env.DAILY_LEAD_AUTOMATION_ENABLED || ""
  )
    .trim()
    .toLowerCase() === "true";

const testAccountsEnabled =
  String(process.env.ENABLE_TEST_ACCOUNTS || "")
    .trim()
    .toLowerCase() === "true";

console.log(
  `[startup] environment ${JSON.stringify({
    loadedFiles,
    checkedFiles,
    cwd: process.cwd(),
    dirname: __dirname,

    nodeEnv:
      process.env.NODE_ENV || "",

    googlePlacesConfigured:
      Boolean(googlePlacesKey),

    googlePlacesKeyLength:
      googlePlacesKey.length,

    testAccountsEnabled,
    dailyAutomationEnabled,

    workspaceId:
      process.env.REACHFLY_TEST_WORKSPACE_ID || "",

    dailyLeadsPerCaller:
      process.env.DAILY_LEADS_PER_CALLER || "",

    dailyLeadTimezone:
      process.env.DAILY_LEAD_TIMEZONE || "",
  })}`
);

if (!loadedFiles.length) {
  console.error(
    `[startup] environment:not-loaded ${JSON.stringify({
      message:
        "No .env file was found. Set DOTENV_CONFIG_PATH to the absolute .env path in PM2.",
      expectedExample:
        "/var/www/reachflybackend/.env",
    })}`
  );
}

if (!googlePlacesKey) {
  console.error(
    "[startup] GOOGLE_PLACES_API_KEY is missing."
  );
}