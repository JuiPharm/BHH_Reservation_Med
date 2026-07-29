/** Consistent, deliberately small API response envelopes. */
function ApiError_(errorCode, safeMessage, errors) {
  this.name = 'ApiError';
  this.errorCode = errorCode;
  this.safeMessage = safeMessage || 'Request could not be completed.';
  this.errors = errors || null;
}

ApiError_.prototype = Object.create(Error.prototype);
ApiError_.prototype.constructor = ApiError_;

function apiSuccess_(data, requestId, message, metadata) {
  const response = { success: true, message: message || 'OK', data: data == null ? {} : data, requestId: requestId || '' };
  const expiresAt = metadata && typeof metadata.sessionExpiresAt === 'string' ? metadata.sessionExpiresAt : '';
  if (expiresAt && isFinite(new Date(expiresAt).getTime())) response.sessionExpiresAt = expiresAt;
  return response;
}

function apiFailure_(error, requestId) {
  const known = error && error.name === 'ApiError';
  const response = {
    success: false,
    message: known ? error.safeMessage : 'Request could not be completed.',
    errorCode: known ? error.errorCode : 'INTERNAL_ERROR',
    requestId: requestId || '',
  };
  if (known && error.errors && error.errors.length) response.errors = error.errors;
  if (known && Number.isFinite(Number(error.retryAfterSeconds))) {
    response.retryAfterSeconds = Math.max(1, Math.min(86400, Math.ceil(Number(error.retryAfterSeconds))));
  }
  return response;
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
