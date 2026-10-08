import { describe, expect, it } from 'vitest';
import { isSourceModuleUrl, loadConfig } from './config.js';

describe('dev-mode detection', () => {
  it('is decided by the module file type, not by folder names in the install path', () => {
    expect(isSourceModuleUrl('file:///home/me/makro-sottver/src/server/config.ts')).toBe(true);
    expect(isSourceModuleUrl('file:///home/me/src/server-apps/MacroPilot/dist/node/server/config.js')).toBe(false);
    expect(isSourceModuleUrl('file:///C:/src/server/MacroPilot/dist/node/server/config.js')).toBe(false);
    expect(isSourceModuleUrl('file:///opt/MacroPilot/dist/node/server/config.js')).toBe(false);
  });

  it('treats the TypeScript sources (tests, tsx) as dev mode', () => {
    const config = loadConfig({ MACROPILOT_DATA_DIR: '/tmp/mp-data', MACROPILOT_KEY_DIR: '/tmp/mp-keys' });
    expect(config.isDev).toBe(true);
    expect(config.openBrowser).toBe(false);
  });
});
