const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const frontend = path.join(root, 'frontend');
const css = (name) => fs.readFileSync(path.join(frontend, 'css', name), 'utf8');
const source = (name) => fs.readFileSync(path.join(frontend, 'js', name), 'utf8');
const workflow = () => fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

test('all frontend pages declare the responsive viewport contract', () => {
  for (const name of fs.readdirSync(frontend).filter((file) => file.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(frontend, name), 'utf8');
    assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1">/i, name);
  }
});

test('responsive styles use mobile-first tablet and desktop breakpoints', () => {
  const styles = ['main.css', 'forms.css', 'dashboard.css', 'admin.css'].map(css).join('\n');
  assert.match(styles, /@media\s*\(min-width:\s*48rem\)/);
  assert.match(styles, /@media\s*\(min-width:\s*64rem\)/);
  assert.match(styles, /\.form-grid\s*\{[^}]*grid-template-columns:\s*1fr[^}]*\}/s);
  assert.match(styles, /\.medication-item\s*\{[^}]*grid-template-columns:\s*1fr[^}]*\}/s);
  assert.match(styles, /\.header-inner\s*\{[^}]*flex-direction:\s*column[^}]*\}/s);
});

test('interactive controls, focus, dialogs, motion and print have safe responsive behavior', () => {
  const main = css('main.css');
  const forms = css('forms.css');
  assert.match(main, /button,\s*input,\s*select\s*\{[^}]*min-height:\s*44px[^}]*\}/s);
  assert.match(main, /\.form-actions a\s*\{[^}]*min-height:\s*44px[^}]*\}/s);
  assert.match(main, /:focus-visible\s*\{[^}]*outline:\s*3px\s+solid\s+var\(--focus\)/s);
  assert.match(main, /dialog\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*2rem\)[^}]*overflow-y:\s*auto/s);
  assert.match(main, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(main, /@media\s+print\s*\{[^}]*\.site-header[^}]*display:\s*none/s);
  assert.match(forms, /overflow-wrap:\s*anywhere/);
});

test('the frontend bundles a licensed Thai font and gives brand and order links 44px targets', () => {
  const main = css('main.css');
  const dashboardSource = source('dashboard.js');
  const adminSource = source('admin.js');
  const font = path.join(frontend, 'assets', 'fonts', 'noto-sans-thai-thai-400-normal.woff2');
  const notice = path.join(frontend, 'assets', 'fonts', 'LICENSE-NotoSansThai.txt');
  assert.equal(fs.existsSync(font), true, 'bundled Thai WOFF2 font is missing');
  assert.equal(fs.statSync(font).size > 8_000, true, 'bundled Thai WOFF2 font is unexpectedly small');
  assert.match(fs.readFileSync(notice, 'utf8'), /SIL Open Font License/i);
  assert.match(main, /@font-face\s*\{[^}]*font-family:\s*['"]Noto Sans Thai['"][^}]*url\(['"]\.\.\/assets\/fonts\/noto-sans-thai-thai-400-normal\.woff2['"]\)\s*format\(['"]woff2['"]\)/s);
  assert.match(main, /html\s*\{[^}]*font-family:\s*['"]Noto Sans Thai['"]/s);
  assert.match(main, /\.brand\s*\{[^}]*min-height:\s*44px/s);
  assert.match(main, /\.order-link\s*\{[^}]*min-height:\s*44px/s);
  assert.match(dashboardSource, /link\.className\s*=\s*['"]order-link['"]/);
  assert.match(adminSource, /link\.className\s*=\s*['"]order-link['"]/);
});

test('dashboard and admin tables become labelled cards on small screens', () => {
  const dashboard = css('dashboard.css');
  const admin = source('admin.js');
  const dashboardSource = source('dashboard.js');
  assert.match(dashboard, /@media\s*\(max-width:\s*47\.99rem\)[\s\S]*?\.orders-table\s+thead\s*\{\s*display:\s*none/s);
  assert.match(dashboard, /\.orders-table\s+td::before\s*\{[^}]*content:\s*attr\(data-label\)/s);
  assert.match(dashboardSource, /cell\.dataset\.label\s*=/);
  assert.match(admin, /cell\.dataset\.label\s*=/);
});

test('Pages deployment publishes only the frontend directory with official major-pinned actions', () => {
  const config = workflow();
  assert.match(config, /^on:\s*[\s\S]*?push:\s*[\s\S]*?branches:\s*\[main\]/m);
  assert.match(config, /workflow_dispatch:/);
  assert.match(config, /permissions:\s*[\s\S]*?pages:\s*write[\s\S]*?id-token:\s*write/m);
  assert.match(config, /actions\/upload-pages-artifact@v3/);
  assert.match(config, /node\s+scripts\/configure-pages\.mjs/);
  assert.match(config, /APPS_SCRIPT_URL:\s*\$\{\{\s*vars\.APPS_SCRIPT_URL\s*\}\}/);
  assert.match(config, /path:\s*frontend\/?\s*$/m);
  assert.match(config, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(config, /path:\s*["']?(?:\.|backend|tests)["']?\s*$/m);
});
