import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [
  process.env.DOTENV_CONFIG_PATH,
  path.join(__dirname, ".env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../../../.env"),
]
  .filter(Boolean)
  .map((value) => path.resolve(value));

const loadedFiles = [];

for (const envPath of [...new Set(envCandidates)]) {
  if (!fs.existsSync(envPath)) {
    continue;
  }

  const result = config({
    path: envPath,
    override: false,
  });

  if (!result.error) {
    loadedFiles.push(envPath);
  }
}

const googlePlacesKey = String(
  process.env.GOOGLE_PLACES_API_KEY || ""
).trim();

console.log(
  `[startup] environment ${JSON.stringify({
    loadedFiles,
    cwd: process.cwd(),
    googlePlacesConfigured: Boolean(
      googlePlacesKey
    ),
    googlePlacesKeyLength:
      googlePlacesKey.length,
  })}`
);