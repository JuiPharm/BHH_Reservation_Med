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

function diagnoseV2_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID_V2') || '').trim();
  const appSecret = String(properties.getProperty('APP_SECRET') || '').trim();
  const info = {
    spreadsheetIdConfigured: Boolean(spreadsheetId),
    appSecretConfigured: Boolean(appSecret),
    appSecretValidLength: appSecret.length === 43 || appSecret.length === 44,
    sheets: {},
  };
  if (spreadsheetId) {
    try {
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const required = ['T_Users', 'S_Sessions', 'T_Reservations', 'T_ReservationItems', 'M_Departments', 'L_AuditLog'];
      for (let i = 0; i < required.length; i++) {
        const name = required[i];
        const sh = ss.getSheetByName(name);
        if (!sh) {
          info.sheets[name] = { exists: false };
        } else {
          const lastRow = sh.getLastRow();
          const lastCol = sh.getLastColumn();
          const headers = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
          info.sheets[name] = {
            exists: true,
            lastRow: lastRow,
            lastCol: lastCol,
            headers: headers,
          };
        }
      }
      const usersSheet = ss.getSheetByName('T_Users');
      if (usersSheet && usersSheet.getLastRow() >= 2) {
        const users = readV2Records_('T_Users');
        info.userCount = users.length;
        info.users = users.map(function(u) { return { staffId: u.StaffID, role: u.Role, status: u.AccountStatus, hasHash: Boolean(u.PasswordHash) }; });
      }
    } catch (e) {
      info.error = String(e && e.message || e);
    }
  }
  return info;
}

