// Jest setup for LUMA.
// The core engine (recipes, adjustments, history, persistence math) is written
// as pure TypeScript with no native dependencies, so most tests need no mocks.
// UI/native mocks are added here only when a specific test suite requires them.

/* global jest */
// Silence the noisy Reanimated/worklets warnings if those modules are ever
// pulled into a test's module graph.
jest.mock('react-native-worklets', () => ({}), { virtual: true });
