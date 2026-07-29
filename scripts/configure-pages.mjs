import fs from 'node:fs';
import path from 'node:path';

const APPS_SCRIPT_URL_PATTERN = /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

function outputPath(args) {
  const index = args.indexOf('--output');
  if (index === -1) return path.resolve('frontend/js/config.js');
  if (!args[index + 1]) throw new Error('--output requires a file path');
  return path.resolve(args[index + 1]);
}

function configuredUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('APPS_SCRIPT_URL is required. Set the non-secret GitHub repository variable APPS_SCRIPT_URL to the deployed Apps Script Web App URL.');
  let url;
  try { url = new URL(raw); }
  catch (_error) { throw new Error('APPS_SCRIPT_URL must be an HTTPS Apps Script web app URL in the form https://script.google.com/macros/s/DEPLOYMENT_ID/exec.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || url.port || url.username || url.password || url.search || url.hash || !APPS_SCRIPT_URL_PATTERN.test(url.pathname)) {
    throw new Error('APPS_SCRIPT_URL must be an HTTPS Apps Script web app URL in the form https://script.google.com/macros/s/DEPLOYMENT_ID/exec.');
  }
  return url.toString();
}

try {
  const apiUrl = configuredUrl(process.env.APPS_SCRIPT_URL);
  const target = outputPath(process.argv.slice(2));
  const source = `// Generated during GitHub Pages deployment. Do not commit a deployment URL here.\nexport const API_URL = ${JSON.stringify(apiUrl)};\n\nexport const APP_CONFIG = Object.freeze({\n  appNameTh: 'ระบบจองยาเฉพาะราย',\n  appNameEn: 'Medication Reservation',\n  organizationName: 'หน่วยงานบริการสุขภาพ',\n  apiUrl: API_URL,\n});\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
  console.log(`Generated ${path.relative(process.cwd(), target)} from APPS_SCRIPT_URL.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
