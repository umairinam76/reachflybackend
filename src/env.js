import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidates = [
  process.env.DOTENV_CONFIG_PATH,
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "src/.env"),
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "../.env"),
  "/var/www/reachflybackend/.env",
]
  .filter(Boolean)
  .map((value) => path.resolve(value));

const unique = [...new Set(candidates)];
const loadedFiles = [];

for (const envPath of unique) {
  if (!fs.existsSync(envPath)) continue;

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

const isProduction =
  String(process.env.NODE_ENV || "")
    .trim()
    .toLowerCase() === "production";

const requiredInProduction = [
  "AUTH_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "SUPABASE_URL",
];

if (
  !process.env.SUPABASE_SECRET_KEY &&
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  requiredInProduction.push(
    "SUPABASE_SECRET_KEY"
  );
}

const missingRequired = requiredInProduction.filter(
  (key) => !String(process.env[key] || "").trim()
);

console.log(
  `[startup] environment ${JSON.stringify({
    loadedFiles,
    nodeEnv: process.env.NODE_ENV || "",
    supabaseConfigured: Boolean(
      process.env.SUPABASE_URL &&
        (process.env.SUPABASE_SECRET_KEY ||
          process.env.SUPABASE_SERVICE_ROLE_KEY)
    ),
    googlePlacesConfigured: Boolean(
      process.env.GOOGLE_PLACES_API_KEY
    ),
    anthropicConfigured: Boolean(
      process.env.ANTHROPIC_API_KEY
    ),
    telnyxConfigured: Boolean(
      process.env.TELNYX_API_KEY &&
        process.env.TELNYX_CONNECTION_ID
    ),
  })}`
);

if (!loadedFiles.length) {
  console.warn(
    "[startup] No .env file was loaded. PM2/systemd environment variables will still be used."
  );
}

if (isProduction && missingRequired.length) {
  throw new Error(
    `Missing required production environment variables: ${missingRequired.join(
      ", "
    )}`
  );
}
