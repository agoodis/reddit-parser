import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const manifestPath = path.join(extensionDir, "manifest.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const requiredPaths = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  "shared/default-subreddits.js",
  "vendor/sql-wasm.js",
  "vendor/sql-wasm.wasm"
].filter(Boolean);

for (const relativePath of requiredPaths) {
  await access(path.join(extensionDir, relativePath));
}

if (manifest.manifest_version !== 3) {
  throw new Error("Expected manifest_version 3");
}

if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("downloads")) {
  throw new Error("Manifest is missing the downloads permission");
}

console.log("Extension manifest and file references look valid.");
