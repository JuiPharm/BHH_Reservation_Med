'use strict';

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function neutralizeFormula(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function escapeHtml(value) {
  const text = value == null ? '' : String(value);
  return text.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character]));
}

function maskHn(value) {
  const hn = typeof value === 'string' ? value.trim() : '';
  return /^07-\d{2}-\d{6}$/.test(hn) ? `07-**-***${hn.slice(-3)}` : '***';
}

function maskPatientName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return '***';
  return name.split(/\s+/).map((part) => `${part[0]}${'*'.repeat(Math.max(2, part.length - 1))}`).join(' ');
}

function sha256Hex(value) {
  try {
    // Node uses this in pure-contract tests; Apps Script calls its platform adapter instead.
    return require('node:crypto').createHash('sha256').update(String(value)).digest('hex');
  } catch (_error) {
    throw new Error('SHA-256 digest requires a platform security adapter');
  }
}

module.exports = Object.freeze({
  constantTimeEqual,
  neutralizeFormula,
  escapeHtml,
  maskHn,
  maskPatientName,
  sha256Hex,
});
