import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  { settings: { next: { rootDir: "apps/web/" } } },
  ...nextVitals,
  globalIgnores(["**/node_modules/**", "**/.next/**", "**/dist/**", "coverage/**"]),
]);
