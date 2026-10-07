/**
 * Session service for BHH Reservation Med v2.
 * Stores only token hashes in S_Sessions.
 */
function createV2Session_(userId) {
  const rawToken = generateV2RandomToken_();
  const tokenHash = sha256V2Hex_(rawToken);
  const now = new Date();
  const timeoutMinutes = boundedV2IntegerConfig_('SESSION_TIMEOUT_MINUTES', 45, 5, 1440);
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60 * 1000);
  const sessionId = 'SES-' + Utilities.getUuid();

  appendV2Records_('S_Sessions', [{
    SessionID: sessionId,
    UserID: String(userId || ''),
    TokenHash: tokenHash,
    CreatedAt: now.toISOString(),
    LastActivityAt: now.toISOString(),
    ExpiresAt: expiresAt.toISOString(),
    Revoked: false,
    RevokedAt: '',
    RevokeReason: '',
  }]);

  return {
    sessionId: sessionId,
    rawToken: rawToken,
    expiresAt: expiresAt.toISOString(),
  };
}

function requireV2Session_(token, options) {
  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!rawToken) throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');

  const tokenHash = sha256V2Hex_(rawToken);
  const sessions = readV2Records_('S_Sessions', {
    predicate: function (row) { return String(row.TokenHash || '') === tokenHash; },
    limit: 1,
  });
  const session = sessions.length ? sessions[0] : null;
  const now = new Date();
  const expiresAt = session ? new Date(session.ExpiresAt) : new Date(0);
  const revoked = session && String(session.Revoked || '').toUpperCase() === 'TRUE';

  if (!session || revoked || !isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  }

  const user = findV2UserById_(session.UserID);
  if (!user || String(user.AccountStatus || '').toUpperCase() !== 'ACTIVE') {
    throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  }

  const timeoutMinutes = boundedV2IntegerConfig_('SESSION_TIMEOUT_MINUTES', 45, 5, 1440);
  const lastActivity = new Date(session.LastActivityAt || session.CreatedAt || 0);
  if (!isFinite(lastActivity.getTime()) || now.getTime() - lastActivity.getTime() > timeoutMinutes * 60 * 1000) {
    updateV2RecordByKey_('S_Sessions', 'SessionID', session.SessionID, {
      Revoked: true,
      RevokedAt: now.toISOString(),
      RevokeReason: 'IDLE_TIMEOUT',
    });
    throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  }

  let clientExpiresAt = expiresAt;
  const touch = !options || options.touch !== false;
  if (touch && now.getTime() - lastActivity.getTime() >= 2 * 60 * 1000) {
    const nextExpiresAt = new Date(now.getTime() + timeoutMinutes * 60 * 1000);
    updateV2RecordByKey_('S_Sessions', 'SessionID', session.SessionID, {
      LastActivityAt: now.toISOString(),
      ExpiresAt: nextExpiresAt.toISOString(),
    });
    clientExpiresAt = nextExpiresAt;
  }

  return {
    sessionId: String(session.SessionID || ''),
    tokenHash: tokenHash,
    user: trustedV2Identity_(user),
    expiresAt: clientExpiresAt.toISOString(),
  };
}

function logoutV2_(context) {
  if (context && context.sessionId) {
    updateV2RecordByKey_('S_Sessions', 'SessionID', context.sessionId, {
      Revoked: true,
      RevokedAt: new Date().toISOString(),
      RevokeReason: 'USER_LOGOUT',
    });
  }
  return { loggedOut: true, apiVersion: 'v2' };
}

function generateV2RandomToken_() {
  let hex = '';
  while (hex.length < 96) hex += Utilities.getUuid().replace(/-/g, '');
  const bytes = [];
  for (let index = 0; index < 96; index += 2) {
    bytes.push(parseInt(hex.substr(index, 2), 16));
  }
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function sha256V2Hex_(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return digest.map(function (byte) {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return (unsigned < 16 ? '0' : '') + unsigned.toString(16);
  }).join('');
}
