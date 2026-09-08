// Minimal module resolver so the Node test runner can import the app's modules
// by their "@/..." tsconfig path alias, the same way Next resolves them.
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

import fs from "node:fs";

// "@/lib/x" -> "<root>/src/lib/x.ts"; extensionless relative imports inside the
// app's own modules are resolved the same way TypeScript does.
function withExtension(file) {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  for (const ext of [".ts", ".tsx", ".mts", ".js", ".mjs"]) {
    if (fs.existsSync(file + ext)) return file + ext;
  }
  for (const ext of ["/index.ts", "/index.tsx"]) {
    if (fs.existsSync(file + ext)) return file + ext;
  }
  return file;
}

export function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    return next(pathToFileURL(withExtension(path.join(root, "src", specifier.slice(2)))).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const abs = path.resolve(path.dirname(new URL(context.parentURL).pathname), specifier);
    const hit = withExtension(abs);
    if (hit !== abs) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
