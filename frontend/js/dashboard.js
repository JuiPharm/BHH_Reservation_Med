import { apiRequest } from './api.js';
import { setLoading, showToast } from './ui.js';

const BANGKOK_TIME = 'Asia/Bangkok';

export function formatBangkokTime(value) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return '—';
  return new Intl.DateTimeFormat('th-TH', { timeZone: BANGKOK_TIME, dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

export async function loadDashboard(filters = {}, request = apiRequest) {
  const query = {
    filters: filters.filters && typeof filters.filters === 'object' ? filters.filters : {},
    search: typeof filters.search === 'string' ? filters.search : '',
    sort: typeof filters.sort === 'string' ? filters.sort : '',
    page: Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1,
  };
  const response = await request('GET_STAFF_DASHBOARD', query);
  return response && response.data ? response.data : response;
}

export function createSearchDebouncer(callback, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), wait);
  };
}

export function bindStatusCard(card, updateFilters) {
  card.addEventListener('click', () => updateFilters({ Status: String(card.dataset.status || '') }));
}

export function nextPage(result) {
  const page = Number(result && result.page) || 1;
  const pageSize = Number(result && result.pageSize) || 25;
  const total = Number(result && result.total) || 0;
  return page * pageSize < total ? page + 1 : page;
}

function textCell(value, label) {
  const cell = document.createElement('td');
  cell.dataset.label = label;
  cell.textContent = String(value == null ? '—' : value);
  return cell;
}

function renderOrders(container, orders) {
  container.replaceChildren();
  (orders || []).forEach((order) => {
    const row = document.createElement('tr');
    const link = document.createElement('a');
    link.className = 'order-link';
    link.href = `order-detail.html?orderId=${encodeURIComponent(String(order.OrderID || ''))}`;
    link.textContent = String(order.OrderID || '—');
    const idCell = document.createElement('td');
    idCell.append(link);
    idCell.dataset.label = 'เลขที่คำขอ';
    row.append(idCell, textCell(order.Status, 'สถานะ'), textCell(order.Priority, 'ความสำคัญ'), textCell(order.ItemCount, 'รายการ'), textCell(formatBangkokTime(order.CreatedAt), 'สร้างเมื่อ'));
    container.append(row);
  });
}

function renderCounts(container, statusCounts, update) {
  container.replaceChildren();
  Object.entries(statusCounts || {}).forEach(([status, count]) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'status-card';
    card.dataset.status = status;
    card.textContent = `${status}: ${count}`;
    bindStatusCard(card, update);
    container.append(card);
  });
}

function renderStatusOptions(select, statusCounts, selected) {
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'ทุกสถานะ';
  select.append(all);
  Object.keys(statusCounts || {}).forEach((status) => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    option.selected = status === selected;
    select.append(option);
  });
}

async function initialize() {
  const root = document.getElementById('staff-dashboard');
  if (!root) return;
  const loading = document.getElementById('page-loading');
  const search = document.getElementById('dashboard-search');
  const status = document.getElementById('dashboard-status');
  const orderRows = document.getElementById('dashboard-orders');
  const countCards = document.getElementById('dashboard-counts');
  const pageLabel = document.getElementById('dashboard-page');
  const previous = document.getElementById('dashboard-previous');
  const following = document.getElementById('dashboard-next');
  let query = { filters: {}, search: '', sort: 'CreatedAt:desc', page: 1 };
  let current = { page: 1, pageSize: 25, total: 0 };
  const render = async () => {
    setLoading(loading, true, 'กำลังโหลดแดชบอร์ด');
    try {
      const data = await loadDashboard(query);
      current = {
        ...current,
        page: Number(data && data.page) || query.page,
        pageSize: Number(data && data.pageSize) || 25,
        total: Number(data && data.total) || Number(data && data.totalOrders) || 0,
      };
      renderCounts(countCards, data.statusCounts, (filters) => { query = { ...query, filters, page: 1 }; status.value = filters.Status; render(); });
      renderStatusOptions(status, data.statusCounts, query.filters.Status || '');
      renderOrders(orderRows, data.recentOrders);
      pageLabel.textContent = `หน้า ${current.page || query.page}`;
      previous.disabled = (current.page || query.page) <= 1;
      following.disabled = nextPage(current) === (current.page || query.page);
    } catch (error) { showToast(error.message || 'ไม่สามารถโหลดแดชบอร์ดได้', 'error'); }
    finally { setLoading(loading, false); }
  };
  const debounced = createSearchDebouncer((value) => { query = { ...query, search: value, page: 1 }; render(); });
  search.addEventListener('input', () => debounced(search.value));
  status.addEventListener('change', () => { query = { ...query, filters: status.value ? { Status: status.value } : {}, page: 1 }; render(); });
  previous.addEventListener('click', () => { query = { ...query, page: Math.max(1, (current.page || query.page) - 1) }; render(); });
  following.addEventListener('click', () => { query = { ...query, page: nextPage(current) }; render(); });
  render();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initialize);
