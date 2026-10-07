export const STATUS_META = Object.freeze({
  SUBMITTED: { label: 'รอตรวจสอบ', hint: 'คำขอใหม่จากหน่วยงาน', tone: 'blue', stage: 'request' },
  UNDER_REVIEW: { label: 'กำลังตรวจสอบ', hint: 'เภสัชกรรมกำลังตรวจสอบคำขอ', tone: 'blue', stage: 'request' },
  ORDERED: { label: 'อยู่ระหว่างจัดหา', hint: 'ดำเนินการสั่งหรือจัดหายาแล้ว', tone: 'amber', stage: 'sourcing' },
  PARTIALLY_RECEIVED: { label: 'ยาเข้าไม่ครบ', hint: 'ได้รับยาบางส่วน ยังรอรายการคงเหลือ', tone: 'amber', stage: 'sourcing' },
  RECEIVED: { label: 'ยาครบแล้ว', hint: 'ยาพร้อมสำหรับขั้นตอนแจ้งรับยา', tone: 'green', stage: 'ready' },
  NOTIFIED: { label: 'แจ้งพร้อมรับแล้ว', hint: 'แจ้งหน่วยงาน/ผู้รับบริการแล้ว', tone: 'green', stage: 'pickup' },
  PATIENT_NO_SHOW: { label: 'ไม่มาตามนัด', hint: 'ต้องติดตามหรือกำหนดนัดใหม่', tone: 'red', stage: 'pickup' },
  APPOINTMENT_RESCHEDULED: { label: 'เลื่อนนัดแล้ว', hint: 'กำหนดวันรับยาใหม่แล้ว', tone: 'blue', stage: 'pickup' },
  PATIENT_RECEIVED: { label: 'รับยาแล้ว', hint: 'ผู้รับบริการรับยาเรียบร้อย', tone: 'green', stage: 'closed' },
  COMPLETED: { label: 'ปิดเคส', hint: 'ดำเนินการครบถ้วนแล้ว', tone: 'gray', stage: 'closed' },
  CANCEL_REQUESTED: { label: 'รอพิจารณายกเลิก', hint: 'มีคำขอยกเลิกที่ต้องดำเนินการ', tone: 'red', stage: 'request' },
  CANCEL_REJECTED: { label: 'ไม่อนุมัติยกเลิก', hint: 'กลับเข้าสู่กระบวนการเดิม', tone: 'blue', stage: 'request' },
  PARTIALLY_CANCELLED: { label: 'ยกเลิกบางรายการ', hint: 'ยังมีรายการยาที่ต้องดำเนินการต่อ', tone: 'amber', stage: 'sourcing' },
  CANCELLED: { label: 'ยกเลิกแล้ว', hint: 'เคสถูกยกเลิก', tone: 'gray', stage: 'closed' },
  REJECTED: { label: 'ไม่รับดำเนินการ', hint: 'คำขอสิ้นสุดโดยไม่ดำเนินการ', tone: 'red', stage: 'closed' },
});

export const WORKFLOW_STAGES = Object.freeze([
  { key: 'request', label: 'รับคำขอ' },
  { key: 'sourcing', label: 'จัดหา / รอยา' },
  { key: 'ready', label: 'ยาพร้อม' },
  { key: 'pickup', label: 'นัดรับยา' },
  { key: 'closed', label: 'เสร็จสิ้น' },
]);

export function statusMeta(status) {
  const key = String(status || '').trim().toUpperCase();
  return STATUS_META[key] || { label: key || 'ไม่ทราบสถานะ', hint: '', tone: 'gray', stage: 'request' };
}

export function statusLabel(status) { return statusMeta(status).label; }
export function statusTone(status) { return statusMeta(status).tone; }
export function workflowStage(status) { return statusMeta(status).stage; }
