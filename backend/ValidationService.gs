const MAX_API_REQUEST_BYTES_ = 1024 * 1024;

function parsePostRequest_(event) {
  const contents = event && event.postData && typeof event.postData.contents === 'string' ? event.postData.contents : '';
  if (!contents || utf8ByteLength_(contents) > MAX_API_REQUEST_BYTES_) throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'body', message: 'A JSON request body is required.' }]);
  let body;
  try {
    body = JSON.parse(contents);
  } catch (_ignored) {
    throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'body', message: 'Body must be valid JSON.' }]);
  }
  return normalizeApiRequest_(body, 'POST', true);
}

function parseGetRequest_(event) {
  const parameters = event && event.parameter ? event.parameter : {};
  const payload = parameters.payload ? parseJsonObject_(parameters.payload) : {};
  return normalizeApiRequest_({ action: parameters.action, requestId: parameters.requestId, payload: payload }, 'GET', true);
}

function utf8ByteLength_(value) {
  return Utilities.newBlob(String(value)).getBytes().length;
}

function parseJsonObject_(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_ignored) {
    return {};
  }
}

function normalizeApiRequest_(body, method, requireRequestId) {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const action = typeof request.action === 'string' ? request.action.trim() : '';
  const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
  if (!action || action.length > 80) throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'action', message: 'Action is required.' }]);
  if (requireRequestId && (!requestId || requestId.length > 128)) throw new ApiError_('VALIDATION_ERROR', 'Invalid request.', [{ field: 'requestId', message: 'Request ID is required.' }]);
  return {
    action: action,
    requestId: requestId,
    sessionToken: typeof request.sessionToken === 'string' ? request.sessionToken.trim() : '',
    payload: request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {},
    method: method,
  };
}
