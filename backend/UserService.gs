function findUserByStaffId_(staffId) {
  const normalized = String(staffId || '').trim();
  if (!normalized) return null;
  const users = readRecords_('Users', { predicate: function (user) { return String(user.StaffID || '') === normalized; }, limit: 1 });
  return users.length ? users[0] : null;
}

function userIsActive_(user) {
  return !!user && String(user.Active || '').toUpperCase() === 'TRUE';
}

function trustedIdentity_(user) {
  if (!user) return null;
  const identity = {
    StaffID: String(user.StaffID || ''),
    FullName: String(user.FullName || ''),
    Department: String(user.Department || ''),
    Email: String(user.Email || ''),
    Role: String(user.Role || '').toUpperCase(),
    PINHash: user.PINHash,
  };
  delete identity.PINHash;
  return identity;
}
