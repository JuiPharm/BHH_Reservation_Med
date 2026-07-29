const APPOINTMENT_REMINDER_HANDLER_ = 'processAppointmentDueReminders';

/** Install the daily reminder trigger idempotently without deleting unrelated triggers. */
function setupAppointmentReminderTrigger() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === APPOINTMENT_REMINDER_HANDLER_;
    });
    if (existing.length) return { created: false, handler: APPOINTMENT_REMINDER_HANDLER_, existing: existing.length };
    const configured = Number(getSetting_('APPOINTMENT_REMINDER_HOUR', '7'));
    const hour = Number.isInteger(configured) && configured >= 0 && configured <= 23 ? configured : 7;
    const timezone = String(getSetting_('TIMEZONE', 'Asia/Bangkok') || 'Asia/Bangkok');
    ScriptApp.newTrigger(APPOINTMENT_REMINDER_HANDLER_).timeBased().everyDays(1).atHour(hour).inTimezone(timezone).create();
    return { created: true, handler: APPOINTMENT_REMINDER_HANDLER_, hour: hour, timezone: timezone };
  } finally { lock.releaseLock(); }
}
