// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'coverage/*'],
  },
  {
    // Lazy `require()` of native modules is intentional: it keeps the pure
    // engine/storage math loadable in Node-based unit tests (and on web) without
    // pulling in native code that only exists on device.
    files: [
      'src/engine/SkiaProcessingEngine.ts',
      'src/storage/kvStore.ts',
      'src/ui/haptics.ts',
      'src/ui/useExport.ts',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]);
