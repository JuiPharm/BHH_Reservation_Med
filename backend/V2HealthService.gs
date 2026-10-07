/**
 * Public, read-only health probe for the v2 Web App deployment.
 * Returns no patient data, credentials, spreadsheet IDs, or secrets.
 */
function healthV2_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID_V2') || '').trim();
  if (!spreadsheetId) {
    return {
      healthy: false,
      apiVersion: 'v2',
      deploymentReachable: true,
      databaseConfigured: false,
      requiredSheetsPresent: false,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const required = ['T_Users', 'S_Sessions', 'T_Reservations', 'T_ReservationItems', 'M_Departments', 'L_AuditLog'];
    const missing = required.filter(function (name) { return !spreadsheet.getSheetByName(name); });
    return {
      healthy: missing.length === 0,
      apiVersion: 'v2',
      deploymentReachable: true,
      databaseConfigured: true,
      requiredSheetsPresent: missing.length === 0,
      missingSheetCount: missing.length,
      timestamp: new Date().toISOString(),
    };
  } catch (_error) {
    return {
      healthy: false,
      apiVersion: 'v2',
      deploymentReachable: true,
      databaseConfigured: true,
      requiredSheetsPresent: false,
      timestamp: new Date().toISOString(),
    };
  }
}
