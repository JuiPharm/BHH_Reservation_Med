const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const traceabilityPath = path.join(root, 'docs/acceptance-traceability.md');
const uatPath = path.join(root, 'docs/uat-checklist.md');
const appsTestsPath = path.join(root, 'backend/Tests.gs');

function tableRows(markdown) {
  return markdown.split('\n').filter((line) => /^\| AC-\d{2} \|/.test(line)).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return { id: cells[0], criterion: cells[1], evidence: cells[2], status: cells[3] };
  });
}

function declaredTestNames(file) {
  const text = fs.readFileSync(file, 'utf8');
  return new Set([...text.matchAll(/\btest\(\s*(['"])(.*?)\1/g)].map((match) => match[2]));
}

test('traceability matrix has exactly sequential criteria, derived totals, and resolvable evidence references', () => {
  const traceability = fs.readFileSync(traceabilityPath, 'utf8');
  const uat = fs.readFileSync(uatPath, 'utf8');
  const appsTests = fs.readFileSync(appsTestsPath, 'utf8');
  const rows = tableRows(traceability);

  assert.equal(rows.length, 44);
  assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 44 }, (_, index) => `AC-${String(index + 1).padStart(2, '0')}`));

  const derived = rows.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, { 'Automated PASS': 0, 'Rendered browser PASS': 0, 'Pending operator/live UAT': 0 });
  assert.deepEqual(derived, {
    'Automated PASS': 28,
    'Rendered browser PASS': 0,
    'Pending operator/live UAT': 16,
  });
  for (const [status, count] of Object.entries(derived)) {
    assert.match(traceability, new RegExp(`\\| ${status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| ${count} \\|`));
  }
  assert.match(traceability, /\| \*\*Total\*\* \| \*\*44\*\* \|/);
  assert.match(traceability, /sixteen pending rows are release blockers/i);

  for (const row of rows) {
    for (const match of row.evidence.matchAll(/`(tests\/[^`]+\.test\.js)`\s+—\s+`([^`]+)`/g)) {
      const [, file, name] = match;
      assert.equal(fs.existsSync(path.join(root, file)), true, `${row.id} cites missing test file ${file}`);
      assert.equal(declaredTestNames(path.join(root, file)).has(name), true, `${row.id} cites missing test ${name}`);
    }
    for (const match of row.evidence.matchAll(/\b(AS-\d{2}|RM-01|FL-\d{2}|AG-\d{2})\b/g)) {
      assert.match(uat, new RegExp(`\\b${match[1]}\\b`), `${row.id} cites missing UAT row ${match[1]}`);
    }
    for (const match of row.evidence.matchAll(/\b(run[A-Za-z]+Tests)\b/g)) {
      assert.match(appsTests, new RegExp(`function\\s+${match[1]}\\s*\\(`), `${row.id} cites missing Apps Script suite ${match[1]}`);
    }
  }
});

test('sanitized rendered-browser evidence records detailed portrait and landscape measurements without sensitive values', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/task-14-responsive-results.json'), 'utf8'));
  const expectedViewports = ['360x800', '390x844', '430x932', '800x360', '844x390', '932x430', '768x1024', '1024x768', '1280x800', '1440x900'];

  assert.deepEqual(evidence.runs.map((run) => run.viewport), expectedViewports);
  assert.equal(evidence.provenance.execution, 'local-static-rendered-browser');
  assert.equal(evidence.provenance.backend, 'deterministic-mock');
  assert.equal(evidence.provenance.backendContacted, false);
  for (const run of evidence.runs) {
    const [width] = run.viewport.split('x').map(Number);
    for (const page of ['login', 'dashboard', 'newOrder', 'orderDetail', 'admin', 'appointment', 'reschedule']) {
      assert.equal(run.layout[page].scrollWidth, width, `${run.viewport} ${page} width`);
      assert.equal(run.layout[page].viewportWidth, width, `${run.viewport} ${page} viewport`);
    }
    assert.ok(run.touchTargets.brandHeight >= 44);
    assert.ok(run.touchTargets.orderLinkHeight >= 44);
    assert.deepEqual(run.medicationItems, { before: 1, afterAdd: 3, afterRemove: 2, validationErrorVisible: true });
    assert.equal(run.focusTrace.length, 3);
    assert.equal(run.focusTrace.every((step) => step.outlineWidthPx === 3), true);
    assert.deepEqual(run.modal, { withinViewport: true, focusContained: true, focusReturned: true });
    assert.deepEqual(run.print, { headerDisplay: 'none', footerDisplay: 'none' });
    assert.ok(run.reducedMotion.transitionDurationMs <= 0.01);
    assert.ok(run.reducedMotion.animationDurationMs <= 0.01);
    assert.deepEqual(run.flows, { appointmentSubmitted: true, rescheduleSubmitted: true });
  }
  assert.deepEqual(evidence.zoom, { effectiveCssViewport: '512x384', page: 'dashboard', noHorizontalOverflow: true, keyboardFocusVisible: true });
  assert.deepEqual(evidence.actionCounts, { dashboardLoads: 21, masterDataLoads: 10, orderDetailLoads: 20, adminLoads: 10, appointmentPreviewLoads: 10, appointmentSubmitCount: 10, reschedulePreviewLoads: 10, rescheduleLoadCount: 10, rescheduleSubmitCount: 10 });

  const banned = /(?:\bhn\b|patient|email|token|https?:\/\/|spreadsheet|deployment|request|opaque|\bMED-\d|\bS-\d|\bOPD\b)/i;
  assert.doesNotMatch(JSON.stringify(evidence), banned);
});
