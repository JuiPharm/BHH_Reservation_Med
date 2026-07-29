/** Pure setup-time Script Property validation. Never include supplied values in errors. */
const SETUP_PROPERTY_NAMES_ = Object.freeze(['SPREADSHEET_ID', 'FRONTEND_BASE_URL', 'APP_SECRET', 'TOKEN_SIGNING_SECRET', 'DEPLOYMENT_ENV']);
const SETUP_ENVIRONMENTS_ = Object.freeze(['development', 'test', 'staging', 'production']);
const GOOGLE_SHEET_ID_PATTERN_ = /^[A-Za-z0-9_-]{20,}$/;
const RANDOM_SECRET_PATTERN_ = /^[A-Za-z0-9_-]{43}=?$/;
const HTTPS_BASE_URL_PATTERN_ = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)?\/?$/i;

function validateSetupConfiguration_(properties) {
  const values = properties && typeof properties === 'object' ? properties : {};
  const errors = [];
  const spreadsheetId = setupPropertyValue_(values, 'SPREADSHEET_ID');
  const frontendBaseUrl = setupPropertyValue_(values, 'FRONTEND_BASE_URL');
  const appSecret = setupPropertyValue_(values, 'APP_SECRET');
  const tokenSigningSecret = setupPropertyValue_(values, 'TOKEN_SIGNING_SECRET');
  const deploymentEnv = setupPropertyValue_(values, 'DEPLOYMENT_ENV');
  const normalizedFrontendBaseUrl = normalizeFrontendBaseUrl_(frontendBaseUrl);

  if (!GOOGLE_SHEET_ID_PATTERN_.test(spreadsheetId)) setupConfigurationError_(errors, 'SPREADSHEET_ID', 'INVALID_SPREADSHEET_ID', 'Use the canonical Google Sheet ID format.');
  if (!normalizedFrontendBaseUrl) setupConfigurationError_(errors, 'FRONTEND_BASE_URL', 'INVALID_FRONTEND_BASE_URL', 'Use a canonical HTTPS base URL without credentials, query, fragment, or whitespace.');
  const appSecretValid = RANDOM_SECRET_PATTERN_.test(appSecret);
  const tokenSigningSecretValid = RANDOM_SECRET_PATTERN_.test(tokenSigningSecret);
  if (!appSecretValid) setupConfigurationError_(errors, 'APP_SECRET', 'INVALID_APP_SECRET', 'Use a distinct 32-byte random Base64URL value.');
  if (!tokenSigningSecretValid) setupConfigurationError_(errors, 'TOKEN_SIGNING_SECRET', 'INVALID_TOKEN_SIGNING_SECRET', 'Use a distinct 32-byte random Base64URL value.');
  if (appSecretValid && tokenSigningSecretValid && canonicalSetupSecret_(appSecret) === canonicalSetupSecret_(tokenSigningSecret)) {
    setupConfigurationError_(errors, 'APP_SECRET', 'SECRETS_MUST_DIFFER', 'Use a distinct 32-byte random Base64URL value.');
    setupConfigurationError_(errors, 'TOKEN_SIGNING_SECRET', 'SECRETS_MUST_DIFFER', 'Use a distinct 32-byte random Base64URL value.');
  }
  if (SETUP_ENVIRONMENTS_.indexOf(deploymentEnv) === -1) setupConfigurationError_(errors, 'DEPLOYMENT_ENV', 'INVALID_DEPLOYMENT_ENV', 'Use one of: development, test, staging, production.');

  return {
    valid: errors.length === 0,
    errors: errors,
    normalized: { FRONTEND_BASE_URL: normalizedFrontendBaseUrl || '' },
  };
}

function setupPropertyValue_(properties, name) {
  const value = properties[name];
  return typeof value === 'string' ? value : '';
}

function normalizeFrontendBaseUrl_(value) {
  if (!value || value !== value.trim()) return '';
  const match = HTTPS_BASE_URL_PATTERN_.exec(value);
  if (!match) return '';
  const host = String(match[1]).toLowerCase();
  const path = String(match[2] || '').replace(/\/+$/, '');
  return 'https://' + host + path;
}

function canonicalSetupSecret_(value) {
  return value.charAt(value.length - 1) === '=' ? value.slice(0, -1) : value;
}

function setupConfigurationError_(errors, field, code, message) {
  errors.push({ field: field, code: code, message: message });
}
