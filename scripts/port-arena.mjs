// One-time, repeatable conversion of the preserved Vercel source.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const web = path.join(root, "artifacts/arenaforge");
const api = path.join(root, "artifacts/api-server");
const arena = path.join(root, "lib/arena");
const source = path.join(root, ".migration-backup");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);

fs.mkdirSync(path.join(arena, "src"), { recursive: true });
fs.cpSync(path.join(source, "src/lib"), path.join(arena, "src/lib"), { recursive: true });
fs.cpSync(path.join(source, "src/app/api"), path.join(api, "src/imported"), { recursive: true });
fs.rmSync(path.join(web, "src/app/api"), { recursive: true, force: true });
fs.rmSync(path.join(web, "src/lib"), { recursive: true, force: true });
// Keep the scaffold cn helper used by its error boundary.
write(path.join(web, "src/lib/utils.ts"), `import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\nexport function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }\n`);
fs.rmSync(path.join(web, "src/db"), { recursive: true, force: true });
fs.rmSync(path.join(web, "src/proxy.ts"), { force: true });
fs.cpSync(path.join(source, "src/db/schema.ts"), path.join(root, "lib/db/src/schema/arena.ts"));
for (const file of fs.readdirSync(path.join(source, "src/db"))) {
  if (file !== "schema.ts" && file !== "index.ts" && file.endsWith(".ts")) {
    fs.cpSync(path.join(source, "src/db", file), path.join(root, "lib/db/src/schema", file));
  }
}
write(path.join(root, "lib/db/src/schema/index.ts"), 'export * from "./arena";\n');

const deps = JSON.parse(fs.readFileSync(path.join(source, "package.json"))).dependencies;
const sharedDependencies = Object.fromEntries(Object.entries(deps).filter(([k]) =>
  !["next", "react", "react-dom", "lucide-react", "@types/mailparser"].includes(k)));
sharedDependencies["@workspace/db"] = "workspace:*";
// React is only needed by browser hooks in the shared source.
sharedDependencies.react = "catalog:";
write(path.join(arena, "package.json"), JSON.stringify({
  name: "@workspace/arena", private: true, type: "module",
  exports: Object.fromEntries(files(path.join(arena, "src")).filter(f => /\.tsx?$/.test(f)).map(f => {
    const relative = path.relative(path.join(arena, "src"), f);
    return ["./" + relative.replace(/\.tsx?$/, "").replace(/\/index$/, ""), "./src/" + relative];
  })), dependencies: sharedDependencies,
}, null, 2) + "\n");

const pageFiles = files(path.join(web, "src/app")).filter(f => f.endsWith("/page.tsx"));
for (const file of files(path.join(web, "src"))) {
  if (!/\.[jt]sx?$/.test(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  text = text.replace(/from "next\/link"/g, 'from "@/routing/Link"')
    .replace(/from "next\/navigation"/g, 'from "@/routing/navigation"')
    .replace(/import type \{ Metadata(?:, Viewport)? \} from "next";/g, "");
  // Parameter-only server wrappers need no network or asynchronous component.
  if (file.includes("/page.tsx") && !text.includes('from "@/db') && !file.includes("/rooms/")) {
    text = text.replace(/export default async function/g, "export default function")
      .replace(/params: Promise<(\{[^}]+\})>/g, "params: $1")
      .replace(/const \{ id \} = await params;/g, "const { id } = params;");
    // Next metadata is moved to the document head by the route shell.
    text = text.replace(/export async function generateMetadata[\s\S]*?\n\}/g, "");
  }
  write(file, text);
}
for (const file of files(path.join(api, "src/imported"))) {
  if (!/\.[jt]s$/.test(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  text = text.replace(/import \{ NextResponse(?:, type NextRequest)? \} from "next\/server";/g,
    "const NextResponse = Response;")
    .replace(/import (?:type )?\{ NextRequest \} from "next\/server";/g, "")
    .replace(/\bNextRequest\b/g, "Request");
  write(file, text);
}
// Shared imports resolve through a workspace package, not another artifact.
for (const dir of [path.join(arena, "src"), path.join(api, "src/imported"), path.join(web, "src")]) {
  for (const file of files(dir)) {
    if (!/\.[jt]sx?$/.test(file)) continue;
    let text = fs.readFileSync(file, "utf8");
    text = text.replace(/(["'])@\/lib\/(.*?)\1/g, '"@workspace/arena/lib/$2"')
      .replace(/(["'])@\/db\/schema\1/g, '"@workspace/db/schema"')
      .replace(/(["'])@\/db\/([^"']+)\1/g, '"@workspace/db/$2"')
      .replace(/(["'])@\/db\1/g, '"@workspace/db"');
    // Scaffold utils are not part of the imported app.
    text = text.replace(/"@workspace\/arena\/lib\/utils"/g, '"@/lib/utils"');
    write(file, text);
  }
}

const routes = pageFiles.map(f => ({
  route: "/" + path.relative(path.join(web, "src/app"), path.dirname(f)).replaceAll(path.sep, "/").replace(/\[([^\]]+)\]/g, ":$1"),
  file: "./" + path.relative(path.join(web, "src"), f).replaceAll(path.sep, "/"),
})).sort((a, b) => b.route.length - a.route.length);
write(path.join(web, "src/routes.ts"), `import { lazy } from "react";\nexport const routes = [\n${routes.map(r =>
  `  { path: ${JSON.stringify(r.route)}, Component: lazy(() => import(${JSON.stringify(r.file)})) },`).join("\n")}\n];\n`);

const apiRoutes = files(path.join(api, "src/imported")).filter(f => f.endsWith("/route.ts")).map(f => {
  const route = "/" + path.relative(path.join(api, "src/imported"), path.dirname(f)).replaceAll(path.sep, "/").replace(/\[([^\]]+)\]/g, ":$1");
  const methods = [...fs.readFileSync(f, "utf8").matchAll(/export (?:async )?function (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map(m => m[1]);
  return { route, methods, file: "./imported/" + path.relative(path.join(api, "src/imported"), f).replaceAll(path.sep, "/") };
}).sort((a, b) => b.route.split("/").filter(s => !s.startsWith(":")).length - a.route.split("/").filter(s => !s.startsWith(":")).length);
write(path.join(api, "src/imported-routes.ts"), `export const importedRoutes = [\n${apiRoutes.map(r =>
  `  { path: ${JSON.stringify(r.route)}, methods: ${JSON.stringify(r.methods)}, load: () => import(${JSON.stringify(r.file)}) },`).join("\n")}\n];\n`);
// Retain the original SQL history and integration helpers, not desktop/mobile builds.
for (const folder of ["drizzle", "desktop-migrations", "bridges"]) {
  fs.cpSync(path.join(source, folder), path.join(arena, folder), { recursive: true });
}
const webPkg = JSON.parse(fs.readFileSync(path.join(web, "package.json")));
Object.assign(webPkg.devDependencies, { "@workspace/arena": "workspace:*", "@workspace/db": "workspace:*", zustand: deps.zustand, "react-router-dom": "^7.9.6", "drizzle-orm": "catalog:" });
write(path.join(web, "package.json"), JSON.stringify(webPkg, null, 2) + "\n");
const apiPkg = JSON.parse(fs.readFileSync(path.join(api, "package.json")));
Object.assign(apiPkg.dependencies, { "@workspace/arena": "workspace:*", react: "catalog:", "react-dom": "catalog:", zod: "^3.25.76" });
write(path.join(api, "package.json"), JSON.stringify(apiPkg, null, 2) + "\n");
const dbPkg = JSON.parse(fs.readFileSync(path.join(root, "lib/db/package.json")));
dbPkg.exports["./schema"] = "./src/schema/index.ts";
dbPkg.exports["./*"] = "./src/schema/*.ts";
write(path.join(root, "lib/db/package.json"), JSON.stringify(dbPkg, null, 2) + "\n");
console.log(`Converted ${routes.length} page routes and ${apiRoutes.length} API route modules.`);
// Split the three genuinely server-rendered pages into data endpoints and
// unchanged React views. Database and bridge clients must never enter Vite.
for (const [route, name, variables] of [
  ["battles/[id]", "BattlePage", ["battle", "turns", "outcome", "nameA", "nameB", "voted"]],
  ["collabs/[id]", "CollabPage", ["collab", "strategy", "drafts", "critiques", "rest"]],
  ["rooms/[roomId]", "RoomDetailPage", ["room", "bridgeStatus"]],
]) {
  const original = fs.readFileSync(path.join(source, "src/app", route, "page.tsx"), "utf8");
  const bodyStart = original.indexOf("  const {");
  const returnStart = original.indexOf("\n  return (", bodyStart);
  let dataCode = original.slice(bodyStart, returnStart)
    .replace(/notFound\(\)/g, 'return Response.json({ error: "Not found" }, { status: 404 })');
  const importLines = [...original.matchAll(/^import .*?;$/gm)].map(m => m[0]);
  const serverImports = importLines.filter(l => /@\/db|drizzle-orm|@\/lib\//.test(l))
    .map(l => l.replaceAll('"@/db/schema"', '"@workspace/db/schema"').replaceAll('"@/db"', '"@workspace/db"').replaceAll('"@/lib/', '"@workspace/arena/lib/')).join("\n");
  const endpointName = route.split("/")[0];
  write(path.join(api, `src/page-data/${endpointName}.ts`),
    `${serverImports}\nexport async function loadPage(params: Record<string,string>) {\n${dataCode}\n  return Response.json({ ${variables.join(", ")} });\n}\n`);
  const clientImports = importLines.filter(l => !/@\/db|drizzle-orm|@\/lib\/|next\/navigation/.test(l))
    .map(l => l.replace('"next/link"', '"@/routing/Link"')).join("\n");
  const markup = original.slice(returnStart).replace(/\bgetStrategy\(/g, "getStrategy(");
  write(path.join(web, "src/app", route, "page.tsx"),
    `${clientImports}\nimport { usePageData } from "@/routing/page-data";\nexport default function ${name}({ params }: { params: Record<string,string> }) {\n  const state = usePageData("${endpointName}", Object.values(params)[0]);\n  if (state.loading) return <p className="text-center text-slate-400">Loading…</p>;\n  if (state.error) return <p role="alert" className="text-center text-slate-400">{state.error}</p>;\n  const { ${variables.join(", ")} } = state.data;\n${markup}\n`);
}
