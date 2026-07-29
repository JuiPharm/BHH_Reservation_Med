const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts', 'configure-pages.mjs');
const validUrl = 'https://script.google.com/macros/s/AKfycbx-Valid_Deployment123/exec';

function run(output, url) {
  const env = { ...process.env };
  if (url === undefined) delete env.APPS_SCRIPT_URL;
  else env.APPS_SCRIPT_URL = url;
  return execFileSync(process.execPath, [script, '--output', output], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('Pages configuration fails clearly when the required public Apps Script URL is missing', () => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pages-config-')), 'config.mjs');
  assert.throws(() => run(output), /APPS_SCRIPT_URL is required/);
  assert.equal(fs.existsSync(output), false);
});

test('Pages configuration rejects URLs that are not deployed HTTPS Apps Script web apps', () => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pages-config-')), 'config.mjs');
  assert.throws(() => run(output, 'https://example.com/macros/s/deployment/exec'), /must be an HTTPS Apps Script web app URL/);
  assert.throws(() => run(output, 'https://script.google.com/macros/s/deployment/dev'), /must be an HTTPS Apps Script web app URL/);
  assert.equal(fs.existsSync(output), false);
});

test('Pages configuration writes a JSON-safe frontend API configuration from the repository variable', async () => {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pages-config-')), 'config.mjs');
  run(output, validUrl);
  const config = await import(`${pathToFileURL(output).href}?test=${Date.now()}`);
  assert.equal(config.API_URL, validUrl);
  assert.equal(config.APP_CONFIG.apiUrl, validUrl);
  assert.match(fs.readFileSync(output, 'utf8'), /Generated during GitHub Pages deployment/);
});
