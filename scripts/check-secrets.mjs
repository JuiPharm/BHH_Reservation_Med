import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.css', '.gs', '.html', '.js', '.json', '.mjs']);
const SCRIPT_PROPERTY_NAMES = [
  'SPREADSHEET' + '_ID',
  'FRONTEND' + '_BASE_URL',
  'APP' + '_SECRET',
  'TOKEN' + '_SIGNING_SECRET',
  'DEPLOYMENT' + '_ENV',
];
const LOCAL_STORAGE = 'local' + 'Storage';
const SESSION_STORAGE = 'session' + 'Storage';
const STAFF_ID = 'staff' + 'id';
const scriptPropertyPattern = SCRIPT_PROPERTY_NAMES.join('|');
const quotedOrTemplateLiteral = "(?:['\"][^'\"]+['\"]|`[^`]+`)";
const scriptPropertyKey = `(?:['\"])?(?:${scriptPropertyPattern})(?:['\"])?`;
const staffIdExpression = [
  `(?:[A-Za-z_$][\\w$]*\\.)?${STAFF_ID}\\b`,
  `(?:[A-Za-z_$][\\w$]*\\s*\\[\\s*['\"]${STAFF_ID}['\"]\\s*\\])`,
].join('|');

const checks = [
  {
    name: 'private key',
    pattern: new RegExp('-----' + 'BEGIN' + ' [A-Z ]+ ' + 'PRIVATE KEY-----'),
  },
  {
    name: 'hard-coded Script Property value',
    pattern: new RegExp(`${scriptPropertyKey}\\s*[:=]\\s*${quotedOrTemplateLiteral}`, 'i'),
  },
  {
    name: 'hard-coded Script Property write',
    pattern: new RegExp(`\\.setProperty\\s*\\(\\s*['\"](?:${scriptPropertyPattern})['\"]\\s*,\\s*${quotedOrTemplateLiteral}`, 'i'),
  },
  {
    name: 'possible hard-coded spreadsheet or secret ID',
    pattern: /\b[A-Za-z0-9_-]{35,}\b/,
  },
  {
    name: 'browser storage',
    pattern: new RegExp(LOCAL_STORAGE),
  },
  {
    name: 'browser storage',
    pattern: new RegExp(SESSION_STORAGE),
  },
  {
    name: 'StaffID numeric conversion',
    pattern: new RegExp('(?:Number|parseInt)' + '\\s*\\(\\s*(?:' + staffIdExpression + ')', 'i'),
  },
];

function trackedSourceFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  return files.filter((file) => {
    const normalized = file.split(path.sep);
    return !normalized.includes('.git') && SOURCE_EXTENSIONS.has(path.extname(file));
  });
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

const violations = [];
for (const file of trackedSourceFiles()) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const check of checks) {
    const match = text.match(check.pattern);
    if (match) {
      violations.push(`${file}:${lineNumber(text, match.index)} ${check.name}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Repository security check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}
