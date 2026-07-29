const APPOINTMENT_REMINDER_HANDLER_ = 'processAppointmentDueReminders';
const NOTIFICATION_QUEUE_HANDLER_ = 'processNotificationQueueTimer';

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

function setupNotificationQueueTrigger() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === NOTIFICATION_QUEUE_HANDLER_;
    });
    if (existing.length) return { created: false, handler: NOTIFICATION_QUEUE_HANDLER_, existing: existing.length };
    ScriptApp.newTrigger(NOTIFICATION_QUEUE_HANDLER_).timeBased().everyMinutes(1).create();
    return { created: true, handler: NOTIFICATION_QUEUE_HANDLER_ };
  } finally { lock.releaseLock(); }
}

function processNotificationQueueTimer() {
  processNotificationQueue_();
}
