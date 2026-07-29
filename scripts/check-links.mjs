import fs from 'node:fs';
import path from 'node:path';

const FRONTEND_ROOT = path.resolve('frontend');
const PARSABLE_EXTENSIONS = new Set(['.html', '.js', '.mjs']);

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(entryPath);
    return PARSABLE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function referencesIn(file, text) {
  const references = [];
  const attributePattern = /(?:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/gi;
  const importPattern = /\b(?:import|export)\s+(?:(?:[^'";]+?)\s+from\s+)?(["'])(.*?)\1/gi;
  const dynamicImportPattern = /\bimport\s*\(\s*(["'])(.*?)\1\s*\)/gi;

  for (const pattern of [attributePattern, importPattern, dynamicImportPattern]) {
    for (const match of text.matchAll(pattern)) references.push(match[2] ?? match[3]);
  }
  return references;
}

function isRelative(reference) {
  return reference !== ''
    && !reference.startsWith('#')
    && !reference.startsWith('/')
    && !/^[a-z][a-z0-9+.-]*:/i.test(reference);
}

function localTarget(reference) {
  return reference.split(/[?#]/, 1)[0];
}

const missing = [];
for (const file of filesIn(FRONTEND_ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const reference of referencesIn(file, text)) {
    if (!isRelative(reference)) continue;
    const target = localTarget(reference);
    if (!target) continue;
    const targetPath = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(targetPath)) {
      missing.push(`${path.relative(process.cwd(), file)} -> ${reference}`);
    }
  }
}

if (missing.length > 0) {
  console.error('Repository link check failed:');
  for (const reference of missing) console.error(`- ${reference}`);
  process.exitCode = 1;
}
