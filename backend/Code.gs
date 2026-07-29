/**
 * Explicit, operator-only initialization. This function is never routed from
 * doGet/doPost; run it once after Script Properties are configured.
 */
function setupApplication() {
  const properties = PropertiesService.getScriptProperties();
  const configuration = validateSetupConfiguration_(properties.getProperties());
  if (!configuration.valid) return { initialized: false, healthy: false, configurationErrors: configuration.errors };
  properties.setProperty('FRONTEND_BASE_URL', configuration.normalized.FRONTEND_BASE_URL);
  const health = initializeDatabase();
  const reminderTrigger = setupAppointmentReminderTrigger();
  return { initialized: true, healthy: Boolean(health && health.healthy), health: health, reminderTrigger: reminderTrigger };
}

function doPost(event) {
  let requestId = '';
  try {
    const request = parsePostRequest_(event);
    requestId = request.requestId;
    const metadata = {};
    return jsonResponse_(apiSuccess_(routeApiRequest_(request, metadata), requestId, '', metadata));
  } catch (error) {
    return jsonResponse_(apiFailure_(error, requestId));
  }
}

function doGet(event) {
  let requestId = '';
  try {
    // GET is intentionally routed only through the closed, non-mutating preview registry.
    const request = parseGetRequest_(event);
    requestId = request.requestId;
    const metadata = {};
    return jsonResponse_(apiSuccess_(routeApiRequest_(request, metadata), requestId, '', metadata));
  } catch (error) {
    return jsonResponse_(apiFailure_(error, requestId));
  }
}
