import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "node_modules", "sql.js", "dist");
const targetDir = path.join(rootDir, "extension", "vendor");

await mkdir(targetDir, { recursive: true });

await copyFile(path.join(sourceDir, "sql-wasm.js"), path.join(targetDir, "sql-wasm.js"));
await copyFile(path.join(sourceDir, "sql-wasm.wasm"), path.join(targetDir, "sql-wasm.wasm"));

console.log("Copied sql.js runtime into extension/vendor");
