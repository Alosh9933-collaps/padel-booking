// Thin client for the Django REST API. Tokens live in localStorage; an expired
// access token is refreshed once, transparently, before giving up.

export type Role = "owner" | "manager" | "receptionist";

export interface Club {
  id: number;
  name: string;
  timezone: string;
  currency: string;
  opening_hour: number;
  closing_hour: number;
  slot_minutes: number;
  role: Role;
  /** Address of the public booking page: /book/<slug>. */
  slug: string;
  online_booking_enabled: boolean;
  online_days_ahead: number;
  online_cancel_hours: number;
  /** Share of the price paid online when booking (0 = no prepayment). */
  online_prepay_percent: number;
  /** Who takes online payments: YooKassa, the demo page (testing only), or nobody yet. */
  payments_provider: "yookassa" | "demo" | null;
  telegram_chat_id: string;
  language: "en" | "ar" | "ru";
}

export interface Court {
  id: number;
  club: number;
  club_name: string;
  name: string;
  kind: "indoor" | "outdoor";
  is_active: boolean;
}

export interface Slot {
  start: string;
  end: string;
  available: boolean;
  price: string | null;
}

export interface Availability {
  court: number;
  date: string;
  timezone: string;
  slots: Slot[];
}

export type PaymentStatus = "unpaid" | "partial" | "paid" | "open";
/** "online" is a prepayment made on the online booking page; staff never enter it by hand. */
export type PaymentMethod = "cash" | "card" | "transfer" | "balance" | "online";
export type MoneyMethod = Exclude<PaymentMethod, "balance" | "online">;
export type DiscountKind = "" | "first_visit" | "nth_visit" | "category" | "manual";

export interface Booking {
  id: number;
  court: number;
  court_name: string;
  start_at: string;
  end_at: string;
  customer: number | null;
  customer_name: string;
  customer_phone: string;
  price: string;
  status: "confirmed" | "cancelled" | "no_show";
  /** Open play still running: end_at is only a hold until closing time. */
  is_open: boolean;
  /** Bookings of one weekly series share this id. */
  series: string | null;
  /** The bill's one discount; `discount` is its money value. */
  discount_kind: DiscountKind;
  discount_percent: string | null;
  discount_fixed: string | null;
  discount_scope: "court" | "total";
  discount_note: string;
  discount: string;
  source: "staff" | "online";
  /** An online booking waiting for its prepayment: the court is only held until then. */
  hold_until: string | null;
  created_at: string;
  cancelled_at: string | null;
  court_total: string;
  items_total: string;
  total: string;
  /** Net money kept: payments minus refunds. */
  paid_total: string;
  refunded_total: string;
  /** How much the customer is owed back (cancelled, or overpaid after a discount). */
  refundable: string;
  balance: string;
  payment_status: PaymentStatus;
}

export interface BillItem {
  id: number;
  product: number | null;
  name: string;
  unit_price: string;
  quantity: number;
  total: string;
  created_at: string;
}

export interface Payment {
  id: number;
  amount: string;
  method: PaymentMethod;
  payer_name: string;
  created_at: string;
  created_by_name: string;
}

export interface Offer {
  kind: "first_visit" | "nth_visit" | "category";
  percent: number;
  amount: string;
  visit: number | null;
  note: string;
}

export interface Refund {
  id: number;
  amount: string;
  method: PaymentMethod;
  reason: string;
  created_at: string;
  created_by_name: string;
}

export interface BookingBill extends Booking {
  items: BillItem[];
  payments: Payment[];
  refunds: Refund[];
  /** Loyalty discounts this booking qualifies for, best first. */
  offers: Offer[];
  /** The customer's prepaid balance, or null without a customer. */
  customer_balance: string | null;
}

export interface CustomerCategory {
  id: number;
  club: number;
  name: string;
  color: string;
  discount_percent: number;
  customers: number;
}

export interface DiscountSettings {
  first_visit_enabled: boolean;
  first_visit_percent: number;
  nth_visit_enabled: boolean;
  nth_visit_every: number;
  nth_visit_percent: number;
}

export interface PriceRule {
  id: number;
  club: number;
  court: number | null;
  days_of_week: number[];
  start_hour: number;
  end_hour: number;
  price_per_hour: string;
  priority: number;
}

export interface RevenueReport {
  club: number;
  currency: string;
  timezone: string;
  date_from: string;
  date_to: string;
  total: string;
  buffet_total: string;
  discount_total: string;
  grand_total: string;
  bookings: number;
  by_court: { court: number; court_name: string; total: string; bookings: number }[];
  by_day: { date: string; total: string; buffet: string; discounts: string; bookings: number }[];
}

export interface DailyReport {
  club: number;
  date: string;
  currency: string;
  /** Bookings + counter sales - refunds. */
  received: string;
  refunds_total: string;
  sales_total: string;
  topups_total: string;
  balance_used: string;
  by_method: {
    method: MoneyMethod | "online";
    bookings: string;
    sales: string;
    topups: string;
    refunds: string;
    total: string;
    count: number;
  }[];
  buffet: { name: string; quantity: number; total: string }[];
  buffet_total: string;
  discount_total: string;
  bookings: number;
  unpaid: Booking[];
  unpaid_total: string;
}

export interface Product {
  id: number;
  club: number;
  name: string;
  category: string;
  price: string;
  is_active: boolean;
}

export interface Customer {
  id: number;
  club: number;
  name: string;
  phone: string;
  category: number | null;
  category_name: string | null;
  category_color: string | null;
  notes: string;
  created_at: string;
  visits: number;
  no_shows: number;
  spent: string;
  balance: string;
  last_visit: string | null;
}

export interface StaffMember {
  id: number;
  club: number;
  user: number;
  username: string;
  full_name: string;
  role: Role;
  last_login: string | null;
}

export interface SaleItem {
  id: number;
  product: number | null;
  name: string;
  unit_price: string;
  quantity: number;
  total: string;
}

export interface Sale {
  id: number;
  club: number;
  customer: number | null;
  customer_name: string;
  method: PaymentMethod;
  total: string;
  items: SaleItem[];
  created_at: string;
  created_by_name: string;
  voided_at: string | null;
  voided_by_name: string;
  void_reason: string;
}

export interface Shift {
  id: number;
  club: number;
  opened_at: string;
  opened_by_name: string;
  opening_cash: string;
  closed_at: string | null;
  closed_by_name: string;
  counted_cash: string | null;
  note: string;
  cash_bookings: string;
  cash_sales: string;
  cash_topups: string;
  cash_refunds: string;
  expected: string;
  difference: string | null;
}

export interface Activity {
  id: number;
  action: string;
  user_name: string;
  booking: number | null;
  sale: number | null;
  amount: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface TopUpPlan {
  id: number;
  club: number;
  name: string;
  price: string;
  credit: string;
  is_active: boolean;
}

export interface BalanceEntry {
  id: number;
  kind: "topup" | "payment" | "sale" | "refund" | "adjustment";
  amount: string;
  paid: string | null;
  method: string;
  plan: number | null;
  plan_name: string | null;
  booking: number | null;
  sale: number | null;
  note: string;
  created_at: string;
  created_by_name: string;
}

export interface DashboardPeriod {
  from: string;
  to: string;
  revenue: string;
  court: string;
  buffet: string;
  discounts: string;
  bookings: number;
  average: string;
  occupancy: number;
  new_customers: number;
  topups: string;
}

export interface Dashboard {
  currency: string;
  this_month: DashboardPeriod;
  last_month: DashboardPeriod;
  heatmap: { from: string; to: string; cells: { weekday: number; hour: number; occupancy: number }[] };
  top_customers: {
    id: number;
    name: string;
    phone: string;
    category_name: string | null;
    category_color: string | null;
    spent: string;
    visits: number;
  }[];
  months: { month: string; revenue: string; bookings: number }[];
}

export interface WeeklyWeek {
  start_at: string;
  end_at: string;
  price: string | null;
  ok: boolean;
  code: string | null;
  detail: string | null;
}

export interface WeeklyResult {
  created: Booking[];
  skipped: WeeklyWeek[];
}

type Paged<T> = T[] | { results: T[] };

const ACCESS_KEY = "padel.access";
const REFRESH_KEY = "padel.refresh";
const USER_KEY = "padel.username";
export const SESSION_EXPIRED = "padel:session-expired";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private mode); the session then lasts one page load.
  }
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    const parts = Object.entries(record).map(([field, value]) => {
      const text = Array.isArray(value) ? value.join(" ") : String(value);
      return field === "non_field_errors" ? text : `${field.replace(/_/g, " ")}: ${text}`;
    });
    if (parts.length) return parts.join(" · ");
  }
  return status >= 500 ? "The server had a problem. Please try again." : `Request failed (${status}).`;
}

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Cannot reach the server. Is Django running?";
  return error instanceof Error ? error.message : "Something went wrong.";
}

type Query = Record<string, string | number | null | undefined>;

interface Options {
  method?: string;
  body?: unknown;
  query?: Query;
}

function send(path: string, options: Options) {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const access = read(ACCESS_KEY);
  if (access) headers.Authorization = `Bearer ${access}`;
  return fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

let refreshing: Promise<boolean> | null = null;

function refreshAccess(): Promise<boolean> {
  // Parallel requests that all hit 401 share one refresh call.
  refreshing ??= (async () => {
    const refresh = read(REFRESH_KEY);
    if (!refresh) return false;
    const res = await fetch("/api/auth/token/refresh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    write(ACCESS_KEY, data.access);
    if (data.refresh) write(REFRESH_KEY, data.refresh);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function api<T>(path: string, options: Options = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && read(REFRESH_KEY) && (await refreshAccess())) {
    res = await send(path, options);
  }
  if (res.status === 401) {
    logout();
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status), data);
  return data as T;
}

function asList<T>(data: Paged<T>): T[] {
  return Array.isArray(data) ? data : data.results;
}

export async function login(username: string, password: string) {
  const res = await fetch("/api/auth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = res.status === 401 ? "Wrong username or password." : errorMessage(data, res.status);
    throw new ApiError(res.status, message, data);
  }
  write(ACCESS_KEY, data.access);
  write(REFRESH_KEY, data.refresh);
  write(USER_KEY, username);
}

export function logout() {
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
}

export function isLoggedIn() {
  return Boolean(read(REFRESH_KEY) || read(ACCESS_KEY));
}

export function currentUsername() {
  return read(USER_KEY) ?? "";
}

export function rememberedClubId(): number | null {
  const raw = read("padel.club");
  return raw ? Number(raw) : null;
}

export function rememberClubId(id: number) {
  write("padel.club", String(id));
}

export type CourtInput = Pick<Court, "name" | "kind" | "is_active"> & { club: number };
export type PriceRuleInput = Omit<PriceRule, "id">;
export type ProductInput = Omit<Product, "id">;
export type CustomerInput = Pick<Customer, "club" | "name" | "phone" | "notes" | "category">;
export type CategoryInput = Omit<CustomerCategory, "id" | "customers">;
export type DiscountInput =
  | { kind: "first_visit" | "nth_visit" | "category" }
  | { kind: "manual"; percent?: string; amount?: string; scope: "court" | "total"; note: string };
export type BookingInput = {
  court: number;
  start_at: string;
  end_at: string;
  customer_name: string;
  customer_phone: string;
};

export interface StaffNotification {
  id: number;
  kind: "online_booking" | "online_cancelled" | "late_payment";
  booking: number | null;
  /** The booking as it was when this happened. */
  data: {
    customer_name: string;
    customer_phone: string;
    court: string;
    start_at: string;
    end_at: string;
    price: string;
    paid: string;
    amount?: string;
  };
  created_at: string;
  unread: boolean;
}

export const Api = {
  notifications: (club: number) =>
    api<{ unread: number; items: StaffNotification[] }>("/notifications/", { query: { club } }),
  notificationsSeen: (club: number) => api<{ unread: number }>("/notifications/seen/", { method: "POST", body: { club } }),
  dashboard: (club: number) => api<Dashboard>("/reports/dashboard/", { query: { club } }),
  searchBookings: (search: string) => api<Paged<Booking>>("/bookings/", { query: { search } }).then((d) => asList(d)),

  plans: (club: number) => api<Paged<TopUpPlan>>("/topup-plans/", { query: { club } }).then((d) => asList(d)),
  createPlan: (body: Omit<TopUpPlan, "id">) => api<TopUpPlan>("/topup-plans/", { method: "POST", body }),
  updatePlan: (id: number, patch: Partial<Omit<TopUpPlan, "id">>) =>
    api<TopUpPlan>(`/topup-plans/${id}/`, { method: "PATCH", body: patch }),
  deletePlan: (id: number) => api<void>(`/topup-plans/${id}/`, { method: "DELETE" }),
  balanceHistory: (customer: number) => api<BalanceEntry[]>(`/customers/${customer}/balance/`),
  topUp: (customer: number, body: { plan?: number; paid?: string; credit?: string; method: MoneyMethod; note: string }) =>
    api<BalanceEntry>(`/customers/${customer}/topup/`, { method: "POST", body }),

  clubs: () => api<Paged<Club>>("/clubs/").then((d) => asList(d)),
  updateClub: (id: number, patch: Partial<Club>) =>
    api<Club>(`/clubs/${id}/`, { method: "PATCH", body: patch }),

  courts: () => api<Paged<Court>>("/courts/").then((d) => asList(d)),
  createCourt: (body: CourtInput) => api<Court>("/courts/", { method: "POST", body }),
  updateCourt: (id: number, patch: Partial<CourtInput>) =>
    api<Court>(`/courts/${id}/`, { method: "PATCH", body: patch }),
  availability: (courtId: number, date: string) =>
    api<Availability>(`/courts/${courtId}/availability/`, { query: { date } }),
  quote: (courtId: number, start: string, end: string) =>
    api<{ price: string }>(`/courts/${courtId}/quote/`, { query: { start, end } }),

  bookings: (query: Query) => api<Paged<Booking>>("/bookings/", { query }).then((d) => asList(d)),
  booking: (id: number) => api<BookingBill>(`/bookings/${id}/`),
  createBooking: (body: BookingInput) => api<BookingBill>("/bookings/", { method: "POST", body }),
  changeBooking: (id: number, patch: Partial<BookingInput>) =>
    api<BookingBill>(`/bookings/${id}/`, { method: "PATCH", body: patch }),
  cancelBooking: (id: number) => api<BookingBill>(`/bookings/${id}/cancel/`, { method: "POST" }),
  cancelFollowing: (id: number) =>
    api<Booking[]>(`/bookings/${id}/cancel-following/`, { method: "POST" }),
  noShow: (id: number) => api<BookingBill>(`/bookings/${id}/no-show/`, { method: "POST" }),
  startOpenPlay: (body: Omit<BookingInput, "start_at" | "end_at">) =>
    api<BookingBill>("/bookings/open/", { method: "POST", body }),
  stopOpenPlay: (id: number) => api<BookingBill>(`/bookings/${id}/stop/`, { method: "POST" }),
  weekly: (body: BookingInput & { weeks: number; dry_run: boolean }) =>
    api<WeeklyResult>("/bookings/weekly/", { method: "POST", body }),

  addItem: (bookingId: number, product: number, quantity = 1) =>
    api<BookingBill>(`/bookings/${bookingId}/items/`, { method: "POST", body: { product, quantity } }),
  setItemQuantity: (bookingId: number, itemId: number, quantity: number) =>
    api<BookingBill>(`/bookings/${bookingId}/items/${itemId}/`, { method: "PATCH", body: { quantity } }),
  applyDiscount: (bookingId: number, body: DiscountInput) =>
    api<BookingBill>(`/bookings/${bookingId}/discount/`, { method: "POST", body }),
  removeDiscount: (bookingId: number) =>
    api<BookingBill>(`/bookings/${bookingId}/discount/`, { method: "DELETE" }),
  addPayment: (bookingId: number, body: { amount: string; method: PaymentMethod; payer_name: string }) =>
    api<BookingBill>(`/bookings/${bookingId}/payments/`, { method: "POST", body }),
  addRefund: (bookingId: number, body: { amount: string; method: PaymentMethod; reason: string }) =>
    api<BookingBill>(`/bookings/${bookingId}/refunds/`, { method: "POST", body }),
  removePayment: (bookingId: number, paymentId: number) =>
    api<BookingBill>(`/bookings/${bookingId}/payments/${paymentId}/`, { method: "DELETE" }),

  priceRules: (club: number) =>
    api<Paged<PriceRule>>("/price-rules/", { query: { club } }).then((d) => asList(d)),
  createPriceRule: (body: PriceRuleInput) => api<PriceRule>("/price-rules/", { method: "POST", body }),
  updatePriceRule: (id: number, body: PriceRuleInput) =>
    api<PriceRule>(`/price-rules/${id}/`, { method: "PUT", body }),
  deletePriceRule: (id: number) => api<void>(`/price-rules/${id}/`, { method: "DELETE" }),

  products: (club: number) => api<Paged<Product>>("/products/", { query: { club } }).then((d) => asList(d)),
  createProduct: (body: ProductInput) => api<Product>("/products/", { method: "POST", body }),
  updateProduct: (id: number, patch: Partial<ProductInput>) =>
    api<Product>(`/products/${id}/`, { method: "PATCH", body: patch }),
  deleteProduct: (id: number) => api<void>(`/products/${id}/`, { method: "DELETE" }),

  customers: (club: number, search = "", category = "") =>
    api<Paged<Customer>>("/customers/", { query: { club, search, category } }).then((d) => asList(d)),
  createCustomer: (body: CustomerInput) => api<Customer>("/customers/", { method: "POST", body }),
  updateCustomer: (id: number, patch: Partial<CustomerInput>) =>
    api<Customer>(`/customers/${id}/`, { method: "PATCH", body: patch }),

  categories: (club: number) =>
    api<Paged<CustomerCategory>>("/customer-categories/", { query: { club } }).then((d) => asList(d)),
  createCategory: (body: CategoryInput) =>
    api<CustomerCategory>("/customer-categories/", { method: "POST", body }),
  updateCategory: (id: number, patch: Partial<CategoryInput>) =>
    api<CustomerCategory>(`/customer-categories/${id}/`, { method: "PATCH", body: patch }),
  deleteCategory: (id: number) => api<void>(`/customer-categories/${id}/`, { method: "DELETE" }),
  discountSettings: (club: number) => api<DiscountSettings>(`/clubs/${club}/discounts/`),
  updateDiscountSettings: (club: number, patch: Partial<DiscountSettings>) =>
    api<DiscountSettings>(`/clubs/${club}/discounts/`, { method: "PATCH", body: patch }),

  sales: (club: number, date: string) =>
    api<Paged<Sale>>("/sales/", { query: { club, date } }).then((d) => asList(d)),
  createSale: (body: {
    club: number;
    items: { product: number; quantity: number }[];
    method: PaymentMethod;
    customer_name: string;
    customer_phone: string;
  }) => api<Sale>("/sales/", { method: "POST", body }),
  voidSale: (id: number, reason: string) => api<Sale>(`/sales/${id}/void/`, { method: "POST", body: { reason } }),

  /** The open shift, or null when the drawer is closed. */
  currentShift: (club: number) =>
    api<Shift | undefined>("/shifts/current/", { query: { club } }).then((s) => s ?? null),
  openShift: (club: number, opening_cash: string) =>
    api<Shift>("/shifts/open/", { method: "POST", body: { club, opening_cash } }),
  closeShift: (id: number, counted_cash: string, note: string) =>
    api<Shift>(`/shifts/${id}/close/`, { method: "POST", body: { counted_cash, note } }),
  shifts: (club: number) => api<Shift[]>("/shifts/", { query: { club } }),

  activity: (query: { club: number; date?: string; booking?: number; action?: string }) =>
    api<Activity[]>("/activity/", { query }),

  staff: (club: number) => api<Paged<StaffMember>>("/staff/", { query: { club } }).then((d) => asList(d)),
  addStaff: (body: { club: number; username: string; password: string; first_name: string; role: Role }) =>
    api<StaffMember>("/staff/", { method: "POST", body }),
  changeStaffRole: (id: number, role: Role) =>
    api<StaffMember>(`/staff/${id}/`, { method: "PATCH", body: { role } }),
  removeStaff: (id: number) => api<void>(`/staff/${id}/`, { method: "DELETE" }),
  setStaffPassword: (id: number, password: string) =>
    api<void>(`/staff/${id}/password/`, { method: "POST", body: { password } }),
  changePassword: (current_password: string, new_password: string) =>
    api<void>("/auth/password/", { method: "POST", body: { current_password, new_password } }),

  revenue: (club: number, from: string, to: string) =>
    api<RevenueReport>("/reports/revenue/", { query: { club, from, to } }),
  daily: (club: number, date: string) => api<DailyReport>("/reports/daily/", { query: { club, date } }),
};

// ---------- Public booking (no login) ----------

export interface PublicClub {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  opening_hour: number;
  closing_hour: number;
  slot_minutes: number;
  /** Customers choose any length from min to max, in steps of step_minutes. */
  min_minutes: number;
  max_minutes: number;
  step_minutes: number;
  /** Share of the price paid online when booking; the court is held hold_minutes while paying. */
  prepay_percent: number;
  hold_minutes: number;
  days_ahead: number;
  cancel_hours: number;
  today: string;
  courts: { id: number; name: string; kind: "indoor" | "outdoor" }[];
}

/** Free start times for one length of game, each with its exact price. */
export interface PublicAvailability {
  date: string;
  minutes: number;
  courts: { id: number; name: string; kind: "indoor" | "outdoor"; times: { start: string; end: string; price: string }[] }[];
}

export interface PublicBooking {
  token: string;
  club: string;
  club_slug: string;
  timezone: string;
  currency: string;
  court: string;
  customer_name: string;
  start_at: string;
  end_at: string;
  price: string;
  status: "confirmed" | "cancelled" | "no_show";
  cancel_until: string;
  can_cancel: boolean;
  telegram_link: string | null;
  /** Waiting for the prepayment: pay at payment_url before hold_until, or the court is freed. */
  awaiting_payment: boolean;
  hold_until: string | null;
  payment_url: string | null;
  prepay_amount: string | null;
  prepaid: string;
  refunded: string;
  /** The prepayment never came, so the booking was released. */
  payment_missed: boolean;
}

/** The demo provider's payment page (testing only). */
export interface DemoPayment {
  id: string;
  amount: string;
  currency: string;
  club: string;
  status: "pending" | "succeeded" | "canceled";
  return_url: string;
}

/** Calls without a session: never sends a token and never signs anyone out. */
async function publicApi<T>(path: string, options: Options = {}): Promise<T> {
  const url = new URL(`/api/public${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: { Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status), data);
  return data as T;
}

export const PublicApi = {
  club: (slug: string) => publicApi<PublicClub>(`/clubs/${slug}/`),
  availability: (slug: string, date: string, minutes: number) =>
    publicApi<PublicAvailability>(`/clubs/${slug}/availability/`, { query: { date, minutes } }),
  book: (
    slug: string,
    body: { court: number; start_at: string; end_at: string; customer_name: string; customer_phone: string; consent: boolean },
  ) => publicApi<PublicBooking>(`/clubs/${slug}/bookings/`, { method: "POST", body }),
  booking: (token: string) => publicApi<PublicBooking>(`/bookings/${token}/`),
  cancel: (token: string) => publicApi<PublicBooking>(`/bookings/${token}/cancel/`, { method: "POST" }),
  demoPayment: (id: string) => publicApi<DemoPayment>(`/payments/${id}/demo/`),
  demoPay: (id: string, result: "succeeded" | "canceled") =>
    publicApi<DemoPayment>(`/payments/${id}/demo/`, { method: "POST", body: { result } }),
};
