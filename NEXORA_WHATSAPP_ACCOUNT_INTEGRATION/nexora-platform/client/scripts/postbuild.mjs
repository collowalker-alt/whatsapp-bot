import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const index = path.join(dist, "index.html");
const adminDir = path.join(dist, "admin");
const adminIndex = path.join(adminDir, "index.html");

if (!fs.existsSync(index)) {
  throw new Error("Vite build did not create dist/index.html");
}

fs.mkdirSync(adminDir, { recursive: true });
fs.copyFileSync(index, adminIndex);
console.log("Created dist/admin/index.html");
