const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const mobileRequire = createRequire(join(__dirname, '../../apps/mobile/package.json'));
const nativeRequire = createRequire(mobileRequire.resolve('@react-navigation/native'));
const navigationDir = dirname(nativeRequire.resolve('@react-navigation/core'));
const screens = { Chat: 'chat' };

test('navigation decodes query parameters through the upgraded decoder', async () => {
  const { getStateFromPath } = await import(pathToFileURL(join(navigationDir, 'getStateFromPath.js')));
  const state = getStateFromPath('/chat?message=hello%20world', { screens });
  assert.equal(state.routes[0].params.message, 'hello world');
});

test('navigation encodes route parameters after dependency upgrades', async () => {
  const { getPathFromState } = await import(pathToFileURL(join(navigationDir, 'getPathFromState.js')));
  const state = { routes: [{ name: 'Chat', params: { message: 'hello world' } }] };
  assert.equal(getPathFromState(state, { screens }), '/chat?message=hello%20world');
});
