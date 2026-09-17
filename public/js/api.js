/** Thin fetch wrapper: JSON in, JSON out, cookies for auth, errors as exceptions. */

export class ApiError extends Error {
  constructor(status, message, code = null, params = null) {
    super(message);
    this.status = status;
    // `code` + `params` are what i18n.errorText() translates; message is the fallback.
    this.code = code;
    this.params = params;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function request(method, path, { body, query } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && !path.includes('/auth/')) onUnauthorized();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code, data?.params);
  }
  return data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body: body ?? {} }),
  put: (path, body) => request('PUT', path, { body: body ?? {} }),
  del: (path) => request('DELETE', path),

  me: () => api.get('/api/auth/me'),
  login: (username, password) => api.post('/api/auth/login', { username, password }),
  logout: () => api.post('/api/auth/logout'),

  products: (query) => api.get('/api/products', query),
  product: (id) => api.get(`/api/products/${id}`),
  lookup: (code) => api.get('/api/products/lookup', { code }),
  saveProduct: (p) => (p.id ? api.put(`/api/products/${p.id}`, p) : api.post('/api/products', p)),
  deleteProduct: (id) => api.del(`/api/products/${id}`),
  adjustStock: (id, qty, note) => api.post(`/api/products/${id}/adjust`, { qty, note }),
  productSales: (id, range) => api.get(`/api/products/${id}/sales`, range),
  productPurchases: (id) => api.get(`/api/products/${id}/purchases`),
  uploadProductImage: (id, data) => api.put(`/api/products/${id}/image`, { data }),
  deleteProductImage: (id) => api.del(`/api/products/${id}/image`),
  categories: () => api.get('/api/categories'),

  purchases: (query) => api.get('/api/purchases', query),
  purchase: (id) => api.get(`/api/purchases/${id}`),
  createPurchase: (p) => api.post('/api/purchases', p),
  updatePurchase: (id, p) => api.put(`/api/purchases/${id}`, p),
  deletePurchase: (id) => api.del(`/api/purchases/${id}`),

  adjustments: (query) => api.get('/api/adjustments', query),
  adjustmentReasons: () => api.get('/api/adjustment-reasons'),

  importProducts: (body) => api.post('/api/products/import', body),
  adjustment: (id) => api.get(`/api/adjustments/${id}`),
  createAdjustment: (a) => api.post('/api/adjustments', a),
  deleteAdjustment: (id) => api.del(`/api/adjustments/${id}`),

  sales: (query) => api.get('/api/sales', query),
  sale: (id) => api.get(`/api/sales/${id}`),
  createSale: (s) => api.post('/api/sales', s),
  deleteSale: (id) => api.del(`/api/sales/${id}`),
  addPayment: (saleId, payment) => api.post(`/api/sales/${saleId}/payments`, payment),
  deletePayment: (id) => api.del(`/api/payments/${id}`),
  receivables: () => api.get('/api/reports/receivables'),

  expenses: (query) => api.get('/api/expenses', query),
  expense: (id) => api.get(`/api/expenses/${id}`),
  saveExpense: (e) => (e.id ? api.put(`/api/expenses/${e.id}`, e) : api.post('/api/expenses', e)),
  deleteExpense: (id) => api.del(`/api/expenses/${id}`),
  expenseCategories: () => api.get('/api/expense-categories'),

  dashboard: () => api.get('/api/reports/dashboard'),
  pnl: (range) => api.get('/api/reports/pnl', range),
  stockHistory: (query) => api.get('/api/reports/stock-history', query),
  stockReport: (range) => api.get('/api/reports/stock', range),
  productReport: (range) => api.get('/api/reports/products', range),
  staffReport: (range) => api.get('/api/reports/staff', range),
  salesAnalysis: (query) => api.get('/api/reports/sales-analysis', query),

  users: () => api.get('/api/users'),
  saveUser: (u) => (u.id ? api.put(`/api/users/${u.id}`, u) : api.post('/api/users', u)),
  deleteUser: (id) => api.del(`/api/users/${id}`),
  changePassword: (current_password, new_password) =>
    api.post('/api/me/password', { current_password, new_password }),

  settings: () => api.get('/api/settings'),
  saveSettings: (s) => api.put('/api/settings', s),
  saveExchangeRate: (rate) => api.put('/api/exchange-rate', { rate }),
  exchangeRates: () => api.get('/api/exchange-rates'),

  entityKinds: () => api.get('/api/entity-kinds'),
  entities: (kind, query) => api.get(`/api/entities/${kind}`, query),
  saveEntity: (kind, e) =>
    e.id ? api.put(`/api/entities/${kind}/${e.id}`, e) : api.post(`/api/entities/${kind}`, e),
  deleteEntity: (kind, id) => api.del(`/api/entities/${kind}/${id}`),
  partySummary: (kind, id) => api.get(`/api/entities/${kind}/${id}/summary`),
  partyStatement: (kind, id, query) => api.get(`/api/entities/${kind}/${id}/statement`, query),
  supplierItems: (id, query) => api.get(`/api/entities/supplier/${id}/items`, query),

  system: () => api.get('/api/system'),
  backupLocal: () => api.post('/api/backup/local'),
};
