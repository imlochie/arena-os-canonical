/**
 * Navigation structure test.
 *
 * Expo Router is file-based, so "navigation" is defined by the files under app/.
 * Rendering the native navigators in jest is heavy and brittle; instead we assert
 * the routing contract: the four primary areas exist as route files, Camera is
 * the index (default landing) route, and the editor/modal routes are present.
 * This catches accidental route removal/rename without a full native render.
 */

import fs from 'fs';
import path from 'path';

const appDir = path.resolve(__dirname, '../../app');

function exists(rel: string): boolean {
  return fs.existsSync(path.join(appDir, rel));
}

describe('router structure', () => {
  it('has a root layout', () => {
    expect(exists('_layout.tsx')).toBe(true);
  });

  it('has a tab group with a custom layout', () => {
    expect(exists('(tabs)/_layout.tsx')).toBe(true);
  });

  it('Camera is the default landing route (index)', () => {
    expect(exists('(tabs)/index.tsx')).toBe(true);
  });

  it('has the four primary areas: Camera, Edit, Create, Settings', () => {
    expect(exists('(tabs)/index.tsx')).toBe(true); // Camera
    expect(exists('(tabs)/edit.tsx')).toBe(true);
    expect(exists('(tabs)/create.tsx')).toBe(true);
    expect(exists('(tabs)/settings.tsx')).toBe(true);
  });

  it('has the editor and info modal routes', () => {
    expect(exists('editor.tsx')).toBe(true);
    expect(exists('licenses.tsx')).toBe(true);
    expect(exists('privacy.tsx')).toBe(true);
  });

  it('each primary route file exports a default React component', () => {
    for (const f of ['(tabs)/index.tsx', '(tabs)/edit.tsx', '(tabs)/create.tsx', '(tabs)/settings.tsx', 'editor.tsx']) {
      const src = fs.readFileSync(path.join(appDir, f), 'utf8');
      expect(src).toMatch(/export default function/);
    }
  });
});
