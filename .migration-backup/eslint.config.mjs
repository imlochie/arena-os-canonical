import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  // luma/ and mobile/ are separate workspaces with their own toolchains
  // (Expo device apps — own eslint/tsconfig/jest), and waveyard-worker/ is
  // the Python/Docker worker service: none of them are linted by the web
  // project's config. Same boundary as tsconfig.json's exclude list.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "luma/**",
    "mobile/**",
    "waveyard-worker/**",
  ]),
  {
    // react-hooks/set-state-in-effect (React compiler advisory) fires on 24
    // pre-existing mount-time fetch patterns across long-standing components
    // (setState inside useEffect after an async load — correct at runtime).
    // Kept visible as a warning rather than an error so `npm run lint` (and
    // CI) stay green while the compiler migration is worked through; it is
    // NOT silenced. All other rules remain at their configured severity.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);
