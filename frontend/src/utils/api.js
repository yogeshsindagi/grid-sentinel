// src/utils/api.js
// API_BASE reads from Vite env variable set in Vercel dashboard.
// Locally falls back to localhost:8000.
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

function getToken() { return localStorage.getItem('gridlock_token'); }
function setToken(token) { localStorage.setItem('gridlock_token', token); }
function clearToken() { localStorage.removeItem('gridlock_token'); localStorage.removeItem('gridlock_user'); }
function getUser() { const u = localStorage.getItem('gridlock_user'); return u ? JSON.parse(u) : null; }
function setUser(user) { localStorage.setItem('gridlock_user', JSON.stringify(user)); }

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    if (!window.location.hash.includes('admin-portal')) {
      window.location.reload();
    }
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || res.statusText || 'Request failed');
  }
  return res.json();
}

export const api = {
  // Auth
  googleLogin: (credential) => request('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }),
  adminLogin: (email, password) => request('/api/auth/admin-login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  demoLogin: (role) => request('/api/auth/demo', { method: 'POST', body: JSON.stringify({ role }) }),
  getMe: () => request('/api/auth/me'),

  // Events
  getEvents: (status = 'active') => request(`/api/events?status=${status}`),
  createEvent: (data) => request('/api/events', { method: 'POST', body: JSON.stringify(data) }),
  resolveEvent: (id) => request(`/api/events/${id}/resolve`, { method: 'POST' }),
  snoozeEvent: (id, mins) => request(`/api/events/${id}/snooze`, { method: 'POST', body: JSON.stringify({ snooze_mins: mins }) }),
  getEventSuggestions: (id) => request(`/api/events/${id}/suggestions`, { method: 'POST' }),

  // Reports
  getReports: (status) => request(`/api/reports${status ? `?status=${status}` : ''}`),
  createReport: (data) => request('/api/reports', { method: 'POST', body: JSON.stringify(data) }),
  updateReportStatus: (id, st) => request(`/api/reports/${id}/status`, { method: 'POST', body: JSON.stringify({ status: st }) }),
  analyzeReport: (id) => request(`/api/reports/${id}/analyze`, { method: 'POST' }),
  verifyReportsBulk: (ids) => request('/api/reports/verify-bulk', { method: 'POST', body: JSON.stringify({ ids }) }),

  // Routing (dual routes)
  getRoute: (startLat, startLon, endLat, endLon) => request('/api/route', {
    method: 'POST', body: JSON.stringify({ start_lat: startLat, start_lon: startLon, end_lat: endLat, end_lon: endLon })
  }),

  // Traffic heatmap
  getTraffic: (bounds, zoom) => {
    const q = bounds ? `?bounds=${bounds.join(',')}&zoom=${zoom || 12}` : '';
    return request(`/api/traffic${q}`);
  },

  // Analytics
  getAnalytics: () => request('/api/analytics'),
  getHistoricalAnalytics: () => request('/api/analytics/historical'),

  // AI
  parseReport: (description, lat, lon) => request('/api/agent/parse', {
    method: 'POST', body: JSON.stringify({ description, latitude: lat, longitude: lon })
  }),
  chat: (message) => request('/api/agent/chat', { method: 'POST', body: JSON.stringify({ message }) }),

  // ML Prediction
  predict: (data) => request('/api/predict', { method: 'POST', body: JSON.stringify(data) }),
  calculateClearance: (data) => request('/api/events/calculate-clearance', { method: 'POST', body: JSON.stringify(data) }),
  previewSuggestions: (data) => request('/api/events/preview-suggestions', { method: 'POST', body: JSON.stringify(data) }),

  // Users (admin)
  getUsers: () => request('/api/users'),
  updateUserRole: (id, role) => request(`/api/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),

  // Settings
  getSettings: () => request('/api/settings'),
  updateSettings: (data) => request('/api/settings', { method: 'POST', body: JSON.stringify(data) }),

  // Helpers
  getToken, setToken, clearToken, getUser, setUser
};
