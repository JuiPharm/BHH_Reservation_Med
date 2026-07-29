import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const backendDirectory = path.join(root, 'backend');
const outputDirectory = path.join(root, 'deploy');
const outputPath = path.join(outputDirectory, 'Code.gs');

const sourceFiles = fs.readdirSync(backendDirectory)
  .filter((name) => name.endsWith('.gs'))
  .sort((left, right) => {
    if (left === 'Code.gs') return -1;
    if (right === 'Code.gs') return 1;
    return left.localeCompare(right);
  });

if (sourceFiles.length === 0) {
  throw new Error('No Apps Script .gs source files were found.');
}

const sections = sourceFiles.map((name) => {
  const source = fs.readFileSync(path.join(backendDirectory, name), 'utf8').trimEnd();
  return [
    '/**',
    ` * Bundled from backend/${name}`,
    ' */',
    source,
  ].join('\n');
});

const banner = [
  '/**',
  ' * Medication Reservation System — single-file Google Apps Script bundle.',
  ' * Generated from the backend/*.gs sources. Do not add appsscript.json here.',
  ` * Source files: ${sourceFiles.length}`,
  ' */',
].join('\n');

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, `${banner}\n\n${sections.join('\n\n')}\n`, 'utf8');

console.log(JSON.stringify({
  output: path.relative(root, outputPath),
  sourceFiles,
  bytes: fs.statSync(outputPath).size,
}, null, 2));
