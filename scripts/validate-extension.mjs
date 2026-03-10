import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const manifestPath = path.join(rootDir, "manifest.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const requiredPaths = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  "extension/shared/default-subreddits.js",
  "extension/vendor/sql-wasm.js",
  "extension/vendor/sql-wasm.wasm"
].filter(Boolean);

for (const relativePath of requiredPaths) {
  await access(path.join(rootDir, relativePath));
}

if (manifest.manifest_version !== 3) {
  throw new Error("Expected manifest_version 3");
}

if (
  manifest.content_security_policy?.extension_pages !==
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
) {
  throw new Error("Manifest must explicitly enable wasm-unsafe-eval for extension_pages");
}

if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("downloads")) {
  throw new Error("Manifest is missing the downloads permission");
}

console.log("Extension manifest and file references look valid.");
