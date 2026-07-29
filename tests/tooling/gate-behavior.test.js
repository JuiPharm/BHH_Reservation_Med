const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');

function temporaryRepository(t, scriptName) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'medication-reservation-gate-'));
  fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, 'scripts', scriptName),
    path.join(directory, 'scripts', scriptName),
  );
  childProcess.execFileSync('git', ['init', '--quiet'], { cwd: directory });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runGate(directory, scriptName) {
  return childProcess.spawnSync(process.execPath, [`scripts/${scriptName}`], {
    cwd: directory,
    encoding: 'utf8',
  });
}

function trackAll(directory) {
  childProcess.execFileSync('git', ['add', '.'], { cwd: directory });
}

function writeSource(directory, source) {
  const sourceDirectory = path.join(directory, 'fixtures');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, 'violation.js'), source);
}

test('secret gate rejects quoted Script Property keys', (t) => {
  const propertyName = 'APP' + '_SECRET';
  const directory = temporaryRepository(t, 'check-secrets.mjs');
  writeSource(directory, `const config = { '${propertyName}': 'configured-value' };\n`);
  trackAll(directory);

  const result = runGate(directory, 'check-secrets.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /hard-coded Script Property value/);
});

test('secret gate rejects template-literal Script Property assignments', (t) => {
  const propertyName = 'APP' + '_SECRET';
  const tick = String.fromCharCode(96);
  const directory = temporaryRepository(t, 'check-secrets.mjs');
  writeSource(directory, `const ${propertyName} = ${tick}configured-value${tick};\n`);
  trackAll(directory);

  const result = runGate(directory, 'check-secrets.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /hard-coded Script Property value/);
});

test('secret gate rejects template-literal Script Property writes', (t) => {
  const propertyName = 'APP' + '_SECRET';
  const tick = String.fromCharCode(96);
  const directory = temporaryRepository(t, 'check-secrets.mjs');
  writeSource(
    directory,
    `PropertiesService.getScriptProperties().setProperty('${propertyName}', ${tick}configured-value${tick});\n`,
  );
  trackAll(directory);

  const result = runGate(directory, 'check-secrets.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /hard-coded Script Property write/);
});

test('secret gate tolerates a tracked source file removed from the working tree during a deletion', (t) => {
  const directory = temporaryRepository(t, 'check-secrets.mjs');
  writeSource(directory, 'export const removedFixture = true;\n');
  trackAll(directory);
  fs.unlinkSync(path.join(directory, 'fixtures', 'violation.js'));

  const result = runGate(directory, 'check-secrets.mjs');

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('link gate rejects missing unquoted href and src targets', (t) => {
  const directory = temporaryRepository(t, 'check-links.mjs');
  const frontendDirectory = path.join(directory, 'frontend');
  fs.mkdirSync(frontendDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(frontendDirectory, 'index.html'),
    '<a href=missing-page.html>Missing</a><script src=missing-module.js></script>\n',
  );

  const result = runGate(directory, 'check-links.mjs');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-page\.html/);
  assert.match(result.stderr, /missing-module\.js/);
});
