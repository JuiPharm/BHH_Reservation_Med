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
  const cacheKey = 'v2_sess_' + tokenHash;
  const now = new Date();

  try {
    const cachedRaw = CacheService.getScriptCache().get(cacheKey);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      const expiresAt = new Date(cached.expiresAt);
      const lastActivity = new Date(cached.lastActivityAt || 0);
      const timeoutMinutes = Number(cached.timeoutMinutes) || 45;

      if (isFinite(expiresAt.getTime()) && expiresAt > now && now.getTime() - lastActivity.getTime() <= timeoutMinutes * 60 * 1000) {
        const touch = !options || options.touch !== false;
        let clientExpiresAt = expiresAt;
        if (touch && now.getTime() - lastActivity.getTime() >= 2 * 60 * 1000) {
          clientExpiresAt = new Date(now.getTime() + timeoutMinutes * 60 * 1000);
          cached.lastActivityAt = now.toISOString();
          cached.expiresAt = clientExpiresAt.toISOString();
          try {
            CacheService.getScriptCache().put(cacheKey, JSON.stringify(cached), 300);
            updateV2RecordByKey_('S_Sessions', 'SessionID', cached.sessionId, {
              LastActivityAt: now.toISOString(),
              ExpiresAt: clientExpiresAt.toISOString(),
            });
          } catch (_ignored) {}
        }
        return {
          sessionId: String(cached.sessionId || ''),
          tokenHash: tokenHash,
          user: cached.user,
          expiresAt: clientExpiresAt.toISOString(),
        };
      }
    }
  } catch (_cacheErr) {}

  const sessions = readV2Records_('S_Sessions', {
    predicate: function (row) { return String(row.TokenHash || '') === tokenHash; },
    limit: 1,
  });
  const session = sessions.length ? sessions[0] : null;
  const expiresAt = session ? new Date(session.ExpiresAt) : new Date(0);
  const revoked = session && String(session.Revoked || '').toUpperCase() === 'TRUE';

  if (!session || revoked || !isFinite(expiresAt.getTime()) || expiresAt <= now) {
    try { CacheService.getScriptCache().remove(cacheKey); } catch (_e) {}
    throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  }

  const user = findV2UserById_(session.UserID);
  if (!user || String(user.AccountStatus || '').toUpperCase() !== 'ACTIVE') {
    try { CacheService.getScriptCache().remove(cacheKey); } catch (_e) {}
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
    try { CacheService.getScriptCache().remove(cacheKey); } catch (_e) {}
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

  const identity = trustedV2Identity_(user);
  const sessionResult = {
    sessionId: String(session.SessionID || ''),
    tokenHash: tokenHash,
    user: identity,
    expiresAt: clientExpiresAt.toISOString(),
  };

  try {
    CacheService.getScriptCache().put(cacheKey, JSON.stringify({
      sessionId: sessionResult.sessionId,
      tokenHash: tokenHash,
      user: identity,
      expiresAt: sessionResult.expiresAt,
      lastActivityAt: now.toISOString(),
      timeoutMinutes: timeoutMinutes,
    }), 300);
  } catch (_ignored) {}

  return sessionResult;
}

function logoutV2_(context) {
  if (context && context.sessionId) {
    updateV2RecordByKey_('S_Sessions', 'SessionID', context.sessionId, {
      Revoked: true,
      RevokedAt: new Date().toISOString(),
      RevokeReason: 'USER_LOGOUT',
    });
  }
  if (context && context.tokenHash) {
    try { CacheService.getScriptCache().remove('v2_sess_' + context.tokenHash); } catch (_e) {}
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
