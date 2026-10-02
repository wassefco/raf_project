/* ============================================================================
 * RAF Marketplace — ACCOUNTING AUTHORITY  (RAFAccounting · shared, headless)
 * ----------------------------------------------------------------------------
 * Finance, phase 1: the ACCOUNTING RECORD. It owns exactly six things:
 *
 *   1. the Chart of Accounts       4. the General Ledger   (derived, read-only)
 *   2. accounting periods          5. the Trial Balance    (derived, read-only)
 *   3. journal entries             6. their audit trail    (through RAFAudit)
 *
 * IT IS THE RECORD, NOT THE BUSINESS. Orders, payments, refunds, settlement,
 * wallet balances, compensation, stores and users stay with their own
 * authorities. Later, each of them may hand a finished business event to
 * postJournal() with a stable source reference; nothing is connected in this
 * phase, and this module never reads or changes those domains.
 *
 * MONEY — whole KWD fils, as non-negative safe integers. A non-integer, a
 * string, a negative or a non-finite amount is REFUSED, never rounded:
 * accounting does no floating-point arithmetic of its own.
 *
 * DATES — accounting dates are Kuwait business dates ('YYYY-MM-DD', Asia/
 * Kuwait, UTC+3 with no daylight saving — the same rule as RAFMarketing /
 * RAFSettlement). "Today" is computed from the epoch with UTC arithmetic, so
 * the browser's own time zone never changes an accounting date.
 *
 * STORAGE — RAFRecordStore collections only, all append-only:
 *     accounting_accounts        the account as created (immutable)
 *     accounting_account_events  activated / deactivated → status is derived
 *     accounting_periods         the period as created (immutable)
 *     accounting_period_events   closed (once)          → status is derived
 *     accounting_journals        posted entries, header + lines (immutable)
 *   No balance, ledger or trial-balance figure is ever stored: every one is
 *   recomputed from accounting_journals, so it is always reproducible.
 *   Nothing is edited or deleted. A correction is a new (reversing or
 *   adjusting) entry — no automatic reversal workflow exists in this phase.
 *
 * IDENTITY & PERMISSION — the actor is ALWAYS the signed-in session. A
 * caller-supplied actor, user, store or role is never accepted. The actor
 * must be an ACTIVE RAF Management account (accountType 'staff', and not a
 * store account) holding the accounting key for the operation:
 *     accounting.view    read anything here
 *     accounting.post    post a journal entry
 *     accounting.manage  maintain the chart of accounts; create periods
 *     accounting.close   close a period
 *   So a customer, merchant, store employee or driver is refused even if a
 *   key were granted to it by override.
 *
 * PROTOTYPE LIMIT — RAFRecordStore's localStorage adapter is not atomic: two
 * tabs can interleave a check and an append. Every write re-reads right
 * before appending, which narrows but does not close that window.
 * Production needs a server-side ledger with conditional writes.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFAccounting) return;

  var VERSION = 1;
  var P = { VIEW:'accounting.view', POST:'accounting.post', MANAGE:'accounting.manage', CLOSE:'accounting.close' };
  var TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
  /* the conventional normal balance of each account type */
  var NORMAL = { asset:'debit', expense:'debit', liability:'credit', equity:'credit', revenue:'credit' };
  var TYPE_TXT = {
    asset:     { ar:'أصول',          en:'Asset' },
    liability: { ar:'التزامات',      en:'Liability' },
    equity:    { ar:'حقوق ملكية',    en:'Equity' },
    revenue:   { ar:'إيرادات',       en:'Revenue' },
    expense:   { ar:'مصروفات',       en:'Expense' }
  };
  var ACCOUNT_STATUS = { ACTIVE:'active', INACTIVE:'inactive' };
  /* accounts withdrawn from RAF accounting. Kept on the chart with their
     history (never rewritten), deactivated by installFoundation, and refused
     by every journal — reactivation included.
     2600 Driver Tips Payable: confirmed — a driver tip is a direct customer →
     driver transaction, not RAF money (no revenue, liability or cash/bank);
     RAFDriverTips keeps its operational record outside the ledger. */
  /* accounts that only their own flows may move (customer / pass-through money) */
  var CUSTOMER_FUNDS = { 'acc-customer-wallet':['wallet', 'refunds', 'settlement', 'gifts'],
                         'acc-gift-code-liability':['gifts'],
                         'acc-gift-code-breakage':['gifts'],
                         'acc-passthrough-clearing':['settlement', 'payouts'] };
  var RETIRED = { 'acc-driver-tips-payable':{ code:'2600', reason:'Driver tips are not RAF money (direct customer → driver transaction)' } };
  var PERIOD_STATUS = { OPEN:'open', CLOSED:'closed' };
  var JOURNAL_STATUS = { POSTED:'posted' };
  /* where an entry comes from. 'manual' is an entry posted by a person; the
     others are the RAF domains that will feed the record later (none is
     connected in this phase). A non-manual entry must carry a reference, and
     a reference can be posted only once (idempotency). */
  var SOURCES = ['manual', 'orders', 'payments', 'refunds', 'settlement', 'wallet', 'compensation', 'expenses', 'payouts', 'gifts'];
  /* technical guards against runaway input — not business rules */
  var LIMITS = { name:120, description:500, memo:200, ref:120, reason:300, lines:500 };

  /* ══════════════════════ THE RAF CHART OF ACCOUNTS (foundation) ══════════════════════
     Installed only by an explicit, authorised call (installFoundation) —
     reading never writes. Idempotent by account ID: an account already present
     is kept exactly as it is (records are immutable), so a browser that holds
     the phase-1 roots receives only the accounts it is missing.

     STRUCTURE — five non-postable roots (one per account type, codes x000,
     never renumbered) and postable leaves directly beneath them in x100-step
     ranges. No intermediate grouping account and no contra account exists:
     none is needed by RAF's current model. New accounts later take the free
     codes inside their type's range (e.g. 1400, 2500, 5800) — existing IDs and
     codes never change. Normal balances are derived from the type.

     RAF'S FINANCIAL MODEL — RAF is a marketplace / intermediary between
     customers and stores, and the chart is shaped by that boundary:
       1. Merchant Payables (2100) is money owed to stores from marketplace
          activity — the merchant's share of what RAF collected.
       2. Customer Wallet Liability (2200) is customer credit held by RAF
          (the RAFWallet balance): RAF owes it to the customer until spent.
       3. Customer Refund Payable (2300) is a refund that has been approved and
          is owed to a customer but has not been completed yet.
       4. Marketplace Commission Revenue (4100) is RAF's own revenue: the
          commission RAFSettlement computes on store sales.
       5. A customer order's gross value is NOT RAF revenue. Money received for
          an order is a receipt (bank / gateway receivable) owed onward to the
          store (Merchant Payables); only the commission is revenue.
       6. Delivery / logistics costs (5200) are RAF's cost, separate from
          merchant sales. The DELIVERY FEE a customer pays is different: it is
          collected by RAF and owed to the delivery company — Delivery Fees
          Payable (2500), a liability, never revenue and never merchant money.
       7. Payment-gateway fees (5100) are RAF's expense; they are not deducted
          from the merchant's commission base unless RAF decides so.
       8. Customer compensation (5300) is an expense of RAF's own goodwill,
          separate from a refund (a refund returns the customer's own money
          and passes through 2300 / the wallet, not an expense).
     No posting rule for any of these exists yet — this phase defines the
     accounts only; no transaction source is connected. */
  var FOUNDATION = [
    /* roots — phase 1, unchanged */
    { accountId:'acc-assets',      code:'1000', nameAr:'الأصول',        nameEn:'Assets',      type:'asset',     root:true },
    { accountId:'acc-liabilities', code:'2000', nameAr:'الالتزامات',    nameEn:'Liabilities', type:'liability', root:true },
    { accountId:'acc-equity',      code:'3000', nameAr:'حقوق الملكية',  nameEn:'Equity',      type:'equity',    root:true },
    { accountId:'acc-revenue',     code:'4000', nameAr:'الإيرادات',     nameEn:'Revenue',     type:'revenue',   root:true },
    { accountId:'acc-expenses',    code:'5000', nameAr:'المصروفات',     nameEn:'Expenses',    type:'expense',   root:true },

    /* assets */
    { accountId:'acc-cash-bank',          code:'1100', type:'asset', parentId:'acc-assets',
      nameAr:'النقد والبنك', nameEn:'Cash & Bank',
      descAr:'الأموال المحتفظ بها لدى رف في البنك أو نقداً.', descEn:'Funds held by RAF in the bank or as cash.' },
    { accountId:'acc-gateway-receivable', code:'1200', type:'asset', parentId:'acc-assets',
      nameAr:'مستحقات بوابة الدفع', nameEn:'Payment Gateway Receivable',
      descAr:'مبالغ دفعها العملاء عبر بوابة الدفع ولم تُحوَّل إلى حساب رف بعد.', descEn:'Customer payments captured by the payment gateway and not yet transferred to RAF.' },
    { accountId:'acc-other-receivables',  code:'1300', type:'asset', parentId:'acc-assets',
      nameAr:'ذمم مدينة أخرى', nameEn:'Other Receivables',
      descAr:'مبالغ أخرى مستحقة لرف.', descEn:'Other amounts owed to RAF.' },

    /* liabilities */
    { accountId:'acc-merchant-payables',  code:'2100', type:'liability', parentId:'acc-liabilities',
      nameAr:'مستحقات التجار', nameEn:'Merchant Payables',
      descAr:'المبالغ المستحقة للمتاجر من نشاط السوق.', descEn:'Amounts owed to stores from marketplace activity.' },
    { accountId:'acc-customer-wallet',    code:'2200', type:'liability', parentId:'acc-liabilities',
      nameAr:'التزامات محافظ العملاء', nameEn:'Customer Wallet Liability',
      descAr:'رصيد العملاء المحتفظ به لدى رف في محافظهم.', descEn:'Customer credit held by RAF in customer wallets.' },
    { accountId:'acc-customer-refunds',   code:'2300', type:'liability', parentId:'acc-liabilities',
      nameAr:'مبالغ مستردة مستحقة للعملاء', nameEn:'Customer Refund Payable',
      descAr:'استردادات معتمدة مستحقة للعملاء لم تكتمل بعد.', descEn:'Approved customer refunds owed but not yet completed.' },
    { accountId:'acc-other-payables',     code:'2400', type:'liability', parentId:'acc-liabilities',
      nameAr:'ذمم دائنة أخرى', nameEn:'Other Payables',
      descAr:'التزامات أخرى على رف.', descEn:'Other amounts RAF owes.' },
    /* confirmed decision: the delivery fee RAF collects from the customer is
       not RAF revenue, not part of the commission base and not merchant money —
       RAF holds it for delivery and owes it to the delivery company. Paying the
       delivery company (and 5200 Delivery / Logistics Costs) is future
       Accounts Payable work; nothing posts here at payment time yet. */
    { accountId:'acc-delivery-fees-payable', code:'2500', type:'liability', parentId:'acc-liabilities',
      nameAr:'مبالغ التوصيل المستحقة', nameEn:'Delivery Fees Payable',
      descAr:'رسوم التوصيل المحصّلة من العملاء، محتفظ بها لغرض التوصيل ومستحقة لشركة التوصيل.', descEn:'Delivery fees collected from customers, held for delivery purposes and payable to the delivery company.' },

    /* confirmed: money customers paid for purchased Gift Codes not yet
       redeemed — owed to the code's holder, never revenue. (2600 is skipped:
       charts installed earlier still hold it on the retired tips account.) */
    { accountId:'acc-gift-code-liability', code:'2700', type:'liability', parentId:'acc-liabilities',
      nameAr:'التزامات رموز الهدايا', nameEn:'Gift Code Liability',
      descAr:'مبالغ دفعها العملاء لشراء رموز هدايا لم تُستخدم بعد — التزام وليست إيراداً.', descEn:'Money customers paid for purchased Gift Codes not yet redeemed — a liability, not revenue.' },
    /* confirmed: a temporary bridge for money passing through RAF's payment
       custody on its way to someone else (driver tips) — never revenue or
       expense; it clears when the money is handed on */
    { accountId:'acc-passthrough-clearing', code:'2800', type:'liability', parentId:'acc-liabilities',
      nameAr:'مقاصة الأموال العابرة', nameEn:'Pass-through Clearing',
      descAr:'أموال تمر عبر رف لصالح غيرها (مثل إكراميات السائقين) إلى أن تُسلَّم — ليست إيراداً ولا مصروفاً.', descEn:'Money passing through RAF on its way to someone else (e.g. driver tips) until handed on — not revenue, not expense.' },

    /* equity */
    { accountId:'acc-paid-in-capital',    code:'3100', type:'equity', parentId:'acc-equity',
      nameAr:'رأس المال المدفوع', nameEn:'Paid-in Capital',
      descAr:'رأس المال الذي ضخّه المالكون في رف.', descEn:'Capital contributed to RAF by its owners.' },
    { accountId:'acc-retained-earnings',  code:'3200', type:'equity', parentId:'acc-equity',
      nameAr:'الأرباح المحتجزة', nameEn:'Retained Earnings',
      descAr:'الأرباح أو الخسائر المتراكمة المحتفظ بها.', descEn:'Accumulated profits or losses kept in the business.' },

    /* revenue */
    { accountId:'acc-commission-revenue', code:'4100', type:'revenue', parentId:'acc-revenue',
      nameAr:'إيرادات عمولة السوق', nameEn:'Marketplace Commission Revenue',
      descAr:'عمولة رف على مبيعات المتاجر — وليست القيمة الإجمالية لطلب العميل.', descEn:'RAF\'s commission on store sales — not the gross value of a customer order.' },
    /* confirmed decision: discounts RAF funds (RAFSettlement's rafBorne) get a
       dedicated revenue-adjustment (contra-revenue) account, kept apart from
       4100 and never an operating expense. Debit-normal — the one legitimate
       contra account. The classification may change in a future accounting
       policy; journals already posted are never rewritten. */
    { accountId:'acc-raf-funded-discounts', code:'4200', type:'revenue', parentId:'acc-revenue', normalBalance:'debit',
      nameAr:'خصومات ممولة من RAF', nameEn:'RAF-funded Discounts',
      descAr:'خصومات تموّلها رف على مبيعات المتاجر (تعديل على الإيرادات) — منفصلة عن إيراد العمولة.', descEn:'Discounts funded by RAF on store sales (a revenue adjustment) — separate from commission revenue.' },

    /* confirmed: the value of a PAID Gift Code that expired unredeemed
       returns to RAF (released from 2700) — a dedicated account, not
       commission (4100), not a discount (4200), not a customer refund */
    { accountId:'acc-gift-code-breakage', code:'4300', type:'revenue', parentId:'acc-revenue',
      nameAr:'قيمة رموز الهدايا المنتهية', nameEn:'Gift Code Expiry (Breakage)',
      descAr:'قيمة رموز هدايا مدفوعة انتهت صلاحيتها دون استخدام وعادت إلى رف — ليست عمولة ولا استرداداً.', descEn:'Value of paid Gift Codes that expired unredeemed and returned to RAF — not commission, not a refund.' },
    /* expenses */
    { accountId:'acc-payment-fees',       code:'5100', type:'expense', parentId:'acc-expenses',
      nameAr:'رسوم معالجة الدفع', nameEn:'Payment Processing Fees',
      descAr:'رسوم بوابة الدفع ومعالجة المدفوعات.', descEn:'Payment gateway and payment processing fees.' },
    { accountId:'acc-delivery-costs',     code:'5200', type:'expense', parentId:'acc-expenses',
      nameAr:'تكاليف التوصيل واللوجستيات', nameEn:'Delivery / Logistics Costs',
      descAr:'تكاليف توصيل الطلبات، منفصلة عن مبيعات التجار.', descEn:'Order delivery costs, separate from merchant sales.' },
    { accountId:'acc-customer-compensation', code:'5300', type:'expense', parentId:'acc-expenses',
      nameAr:'تعويضات العملاء', nameEn:'Customer Compensation',
      descAr:'تعويضات تمنحها رف للعملاء، منفصلة عن الاستردادات.', descEn:'Compensation RAF grants customers, separate from refunds.' },
    { accountId:'acc-marketing-expense',  code:'5400', type:'expense', parentId:'acc-expenses',
      nameAr:'مصروفات التسويق', nameEn:'Marketing Expense',
      descAr:'مصروفات التسويق والترويج.', descEn:'Marketing and promotion expenses.' },
    { accountId:'acc-technology-expense', code:'5500', type:'expense', parentId:'acc-expenses',
      nameAr:'مصروفات التقنية والاستضافة', nameEn:'Technology / Hosting Expense',
      descAr:'تكاليف التقنية والاستضافة والخدمات البرمجية.', descEn:'Technology, hosting and software service costs.' },
    { accountId:'acc-bank-fees',          code:'5600', type:'expense', parentId:'acc-expenses',
      nameAr:'الرسوم البنكية', nameEn:'Bank Fees',
      descAr:'الرسوم التي يتقاضاها البنك.', descEn:'Charges levied by the bank.' },
    { accountId:'acc-general-operating',  code:'5700', type:'expense', parentId:'acc-expenses',
      nameAr:'مصروفات تشغيلية عامة', nameEn:'General Operating Expense',
      descAr:'مصروفات تشغيلية أخرى غير مصنفة أعلاه.', descEn:'Other operating expenses not classified above.' }
  ];

  /* ---------- language / errors ---------- */
  function isEn(){ var r = global.document && (document.getElementById('htmlRoot') || document.documentElement); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAVAILABLE:          { ar:'تعذّر الوصول إلى السجل المحاسبي.',                 en:'The accounting record is unavailable.' },
    UNAUTHENTICATED:      { ar:'يلزم تسجيل الدخول.',                               en:'Sign-in is required.' },
    ACTOR_INACTIVE:       { ar:'لا يمكن تنفيذ الإجراء بحساب موقوف.',               en:'A suspended account cannot perform this action.' },
    FORBIDDEN:            { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',                en:'You do not have permission for this action.' },
    FIELD_NOT_ACCEPTED:   { ar:'تحتوي البيانات على حقول غير مقبولة.',              en:'The request contains fields that are not accepted.' },
    INVALID:              { ar:'راجع البيانات المطلوبة.',                          en:'Check the required fields.' },
    ACCOUNT_ID_INVALID:   { ar:'معرّف الحساب غير صالح.',                           en:'The account ID is not valid.' },
    ACCOUNT_ID_EXISTS:    { ar:'يوجد حساب بهذا المعرّف.',                          en:'An account with this ID already exists.' },
    ACCOUNT_CODE_INVALID: { ar:'رمز الحساب غير صالح.',                             en:'The account code is not valid.' },
    ACCOUNT_CODE_EXISTS:  { ar:'رمز الحساب مستخدم لحساب آخر.',                     en:'The account code is already used by another account.' },
    ACCOUNT_NAME_REQUIRED:{ ar:'اسم الحساب مطلوب.',                                en:'The account name is required.' },
    ACCOUNT_TYPE_INVALID: { ar:'نوع الحساب غير صالح.',                             en:'The account type is not valid.' },
    NORMAL_BALANCE_INVALID:{ ar:'طبيعة رصيد الحساب غير صالحة.',                    en:'The normal balance is not valid.' },
    PARENT_NOT_FOUND:     { ar:'الحساب الرئيسي غير موجود.',                        en:'The parent account does not exist.' },
    PARENT_TYPE_MISMATCH: { ar:'يجب أن يكون الحساب الرئيسي من النوع نفسه.',        en:'The parent account must be of the same type.' },
    ACCOUNT_NOT_FOUND:    { ar:'الحساب غير موجود.',                                en:'The account does not exist.' },
    ALREADY_ACTIVE:       { ar:'الحساب مفعّل بالفعل.',                             en:'The account is already active.' },
    ALREADY_INACTIVE:     { ar:'الحساب موقوف بالفعل.',                             en:'The account is already inactive.' },
    ACCOUNT_RETIRED:      { ar:'هذا الحساب لم يعد مستخدماً في محاسبة رف.',          en:'This account is no longer used in RAF accounting.' },
    DATE_INVALID:         { ar:'التاريخ غير صالح.',                                en:'The date is not valid.' },
    PERIOD_RANGE_INVALID: { ar:'يجب ألا يسبق تاريخ النهاية تاريخ البداية.',        en:'The end date cannot be before the start date.' },
    PERIOD_OVERLAP:       { ar:'تتداخل الفترة مع فترة محاسبية موجودة.',            en:'The period overlaps an existing accounting period.' },
    PERIOD_NOT_FOUND:     { ar:'الفترة المحاسبية غير موجودة.',                     en:'The accounting period does not exist.' },
    PERIOD_CLOSED:        { ar:'الفترة المحاسبية مقفلة.',                          en:'The accounting period is closed.' },
    NO_PERIOD:            { ar:'لا توجد فترة محاسبية تغطي هذا التاريخ.',           en:'No accounting period covers this date.' },
    DESCRIPTION_REQUIRED: { ar:'وصف القيد مطلوب.',                                 en:'The entry description is required.' },
    SOURCE_INVALID:       { ar:'مصدر القيد غير صالح.',                             en:'The entry source is not valid.' },
    SOURCE_REF_REQUIRED:  { ar:'مرجع المصدر مطلوب.',                               en:'A source reference is required.' },
    SOURCE_CONFLICT:      { ar:'هذا المرجع مُرحَّل بالفعل بقيد مختلف.',           en:'This source reference was already posted with a different entry.' },
    JOURNAL_ID_INVALID:   { ar:'معرّف القيد غير صالح.',                            en:'The journal ID is not valid.' },
    JOURNAL_EXISTS:       { ar:'يوجد قيد بهذا المعرّف.',                           en:'A journal entry with this ID already exists.' },
    JOURNAL_NOT_FOUND:    { ar:'القيد غير موجود.',                                 en:'The journal entry does not exist.' },
    TOO_FEW_LINES:        { ar:'يجب أن يحتوي القيد على سطرين على الأقل.',          en:'A journal entry needs at least two lines.' },
    LINES_INVALID:        { ar:'بعض أسطر القيد غير صالحة.',                        en:'Some journal lines are not valid.' },
    UNBALANCED:           { ar:'مجموع المدين لا يساوي مجموع الدائن.',              en:'Total debits do not equal total credits.' },
    FOUNDATION_CONFLICT:  { ar:'رمز حساب في دليل رف مستخدم لحساب آخر؛ لم يُثبَّت شيء.', en:'A RAF chart code is held by another account; nothing was installed.' },
    PERSIST_FAILED:       { ar:'تعذّر الحفظ.',                                     en:'Could not save.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }

  /* ---------- helpers ---------- */
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function text(v){ return typeof v === 'string' ? v.trim() : ''; }
  function isObj(o){ return !!o && typeof o === 'object' && !Array.isArray(o); }
  function badKeys(o, allowed){ return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; }); }
  function Perm(){ return global.RAFPerm || null; }
  function RS(){ return global.RAFRecordStore || null; }
  function coll(name){ var s = RS(); if (!s) return null; try { return s.collection(name); } catch (e) { return null; } }
  function newId(prefix){ var s = RS(); return s ? s.makeId(prefix) : prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

  /* money: a fils amount is a non-negative safe integer, nothing else */
  function isFils(v){ return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }

  /* Kuwait business dates — UTC+3, no daylight saving */
  var KW_OFFSET_MS = 3 * 3600000;
  function kuwaitDateOf(ms){ return new Date(ms + KW_OFFSET_MS).toISOString().slice(0, 10); }
  function todayKuwait(){ return kuwaitDateOf(Date.now()); }
  function isDate(s){
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  /* ══════════════════════ IDENTITY & PERMISSION ══════════════════════ */
  function actor(key){
    var R = Perm();
    if (!R || !RS()) return fail('UNAVAILABLE');
    var sid = null; try { sid = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { sid = null; }
    var u = null; if (sid) { try { u = R.getUser(sid); } catch (e) { u = null; } }
    if (!u || !u.id) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    /* the accounting record is RAF Management's: never a customer, store or
       driver account, whatever keys it may hold */
    var mgmt = false; try { mgmt = u.accountType === 'staff' && !R.isMerchant(u.id); } catch (e) { mgmt = false; }
    if (!mgmt) return fail('FORBIDDEN', { required:key });
    var ok = false; try { ok = !!R.can(u.id, key); } catch (e) { ok = false; }
    if (!ok) return fail('FORBIDDEN', { required:key });
    return { ok:true, id:u.id, name:u.name || null };
  }
  function can(key){ return actor(key).ok; }

  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try {
      var o = { action:action, actor:{ id:a.id }, source:'admin' };
      for (var k in (extra || {})) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }

  /* ══════════════════════ CHART OF ACCOUNTS ══════════════════════ */
  function accountRows(){ var c = coll('accounting_accounts'); return c ? c.all() : []; }
  function accountEventRows(){ var c = coll('accounting_account_events'); return c ? c.all() : []; }
  /* the derived chart: each account with its current status */
  function chart(){
    var last = {};
    accountEventRows().forEach(function (e) {
      if (!last[e.accountId] || (e.seq || 0) > (last[e.accountId].seq || 0)) last[e.accountId] = e;
    });
    return accountRows().map(function (r) {
      var ev = last[r.accountId];
      return {
        accountId:r.accountId, code:r.code, nameAr:r.nameAr || null, nameEn:r.nameEn || null,
        type:r.type, normalBalance:r.normalBalance, parentId:r.parentId || null, postable:r.postable !== false,
        description:r.description || null,
        descriptionAr:r.descriptionAr || null, descriptionEn:r.descriptionEn || null,
        status:ev ? (ev.kind === 'deactivated' ? ACCOUNT_STATUS.INACTIVE : ACCOUNT_STATUS.ACTIVE) : ACCOUNT_STATUS.ACTIVE,
        statusChangedAt:ev ? ev.at : null,
        createdAt:r.createdAt, createdBy:r.createdBy || null, foundation:!!r.foundation
      };
    });
  }
  function accountById(id){ return chart().filter(function (a) { return a.accountId === id; })[0] || null; }
  function nameOf(a){ return a ? (isEn() ? (a.nameEn || a.nameAr) : (a.nameAr || a.nameEn)) : null; }

  function validAccountId(id){ return typeof id === 'string' && /^[a-z][a-z0-9-]{2,47}$/.test(id); }
  function validCode(c){ return typeof c === 'string' && /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/.test(c); }

  /* the write itself, after authorisation and validation */
  function appendAccount(a, rec){
    var c = coll('accounting_accounts'); if (!c) return fail('UNAVAILABLE');
    /* re-check uniqueness right before the append */
    var cur = accountRows();
    if (cur.some(function (r) { return r.accountId === rec.accountId; })) return fail('ACCOUNT_ID_EXISTS', { accountId:rec.accountId });
    if (cur.some(function (r) { return String(r.code).toLowerCase() === String(rec.code).toLowerCase(); })) return fail('ACCOUNT_CODE_EXISTS', { accountCode:rec.code });
    var w = c.append('accountId', rec);
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('accounting.account_created', a, { key:rec.accountId, newState:ACCOUNT_STATUS.ACTIVE,
      metadata:{ accountId:rec.accountId, code:rec.code, type:rec.type, normalBalance:rec.normalBalance,
                 parentId:rec.parentId, postable:rec.postable, foundation:!!rec.foundation } });
    return { ok:true, account:copy(accountById(rec.accountId)) };
  }

  function createAccount(input){
    var a = actor(P.MANAGE); if (!a.ok) return a;
    if (!isObj(input)) return fail('INVALID');
    var bad = badKeys(input, ['accountId', 'code', 'nameAr', 'nameEn', 'type', 'normalBalance', 'parentId', 'postable', 'description', 'descriptionAr', 'descriptionEn']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    if (!validAccountId(input.accountId)) return fail('ACCOUNT_ID_INVALID');
    if (!validCode(input.code)) return fail('ACCOUNT_CODE_INVALID');
    var nameAr = text(input.nameAr), nameEn = text(input.nameEn);
    if (!nameAr && !nameEn) return fail('ACCOUNT_NAME_REQUIRED');
    if (nameAr.length > LIMITS.name || nameEn.length > LIMITS.name) return fail('INVALID', { field:'name' });
    if (TYPES.indexOf(input.type) < 0) return fail('ACCOUNT_TYPE_INVALID');
    var nb = input.normalBalance === undefined ? NORMAL[input.type] : input.normalBalance;
    if (nb !== 'debit' && nb !== 'credit') return fail('NORMAL_BALANCE_INVALID');
    if (input.postable !== undefined && typeof input.postable !== 'boolean') return fail('INVALID', { field:'postable' });
    var desc = input.description === undefined ? '' : text(input.description);
    var descAr = input.descriptionAr === undefined ? '' : text(input.descriptionAr);
    var descEn = input.descriptionEn === undefined ? '' : text(input.descriptionEn);
    if ([desc, descAr, descEn].some(function (d) { return d.length > LIMITS.description; })) return fail('INVALID', { field:'description' });
    var parentId = input.parentId == null ? null : input.parentId;
    if (parentId !== null) {
      var p = accountById(parentId);
      if (!p) return fail('PARENT_NOT_FOUND');
      if (p.type !== input.type) return fail('PARENT_TYPE_MISMATCH');
    }
    var cur = accountRows();
    if (cur.some(function (r) { return r.accountId === input.accountId; })) return fail('ACCOUNT_ID_EXISTS', { accountId:input.accountId });
    if (cur.some(function (r) { return String(r.code).toLowerCase() === input.code.toLowerCase(); })) return fail('ACCOUNT_CODE_EXISTS', { accountCode:input.code });
    return appendAccount(a, {
      accountId:input.accountId, code:input.code, nameAr:nameAr || null, nameEn:nameEn || null,
      type:input.type, normalBalance:nb, parentId:parentId, postable:input.postable !== false,
      description:desc || null, descriptionAr:descAr || null, descriptionEn:descEn || null,
      createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:1
    });
  }

  /* the RAF chart — idempotent by account ID: an account already present is
     kept exactly as it is. Every missing account is checked first; if any of
     their codes is already held by a DIFFERENT account, nothing is written
     (the chart is never left half-installed and no code is ever taken over). */
  function installFoundation(){
    var a = actor(P.MANAGE); if (!a.ok) return a;
    var have = {}, codes = {};
    accountRows().forEach(function (r) { have[r.accountId] = r; codes[String(r.code).toLowerCase()] = r.accountId; });
    var missing = FOUNDATION.filter(function (f) { return !have[f.accountId]; });
    var conflicts = missing.filter(function (f) { return codes[f.code.toLowerCase()]; })
      .map(function (f) { return { accountId:f.accountId, code:f.code, heldBy:codes[f.code.toLowerCase()] }; });
    if (conflicts.length) return fail('FOUNDATION_CONFLICT', { conflicts:conflicts });
    /* an account already present under a foundation ID is reported when it does
       not match the definition — never rewritten */
    var differs = FOUNDATION.filter(function (f) {
      var r = have[f.accountId];
      return r && (r.code !== f.code || r.type !== f.type || (r.parentId || null) !== (f.parentId || null));
    }).map(function (f) { return f.accountId; });
    var created = [], kept = FOUNDATION.filter(function (f) { return have[f.accountId]; }).map(function (f) { return f.accountId; });
    for (var i = 0; i < missing.length; i++) {
      var f = missing[i];
      var r = appendAccount(a, { accountId:f.accountId, code:f.code, nameAr:f.nameAr, nameEn:f.nameEn, type:f.type,
        normalBalance:f.normalBalance || NORMAL[f.type], parentId:f.parentId || null, postable:!f.root, description:null,
        descriptionAr:f.descAr || null, descriptionEn:f.descEn || null, foundation:true,
        createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:1 });
      if (!r.ok) return Object.assign(r, { created:created });
      created.push(f.accountId);
    }
    /* a retired account already on the chart stays (with its history) but is
       deactivated through the ordinary append-only status event */
    var retired = [];
    Object.keys(RETIRED).forEach(function (id) {
      var acc = accountById(id);
      if (!acc || acc.code !== RETIRED[id].code || acc.status !== ACCOUNT_STATUS.ACTIVE) return;
      var d = setStatus(id, ACCOUNT_STATUS.INACTIVE, { reason:RETIRED[id].reason });
      if (d.ok) retired.push(id);
    });
    return { ok:true, created:created, kept:kept, differs:differs, retired:retired };
  }

  function setStatus(accountId, to, input){
    var a = actor(P.MANAGE); if (!a.ok) return a;
    input = input || {};
    if (!isObj(input)) return fail('INVALID');
    var bad = badKeys(input, ['reason']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var reason = text(input.reason); if (reason.length > LIMITS.reason) return fail('INVALID', { field:'reason' });
    var acc = accountById(accountId); if (!acc) return fail('ACCOUNT_NOT_FOUND');
    if (acc.status === to) return fail(to === ACCOUNT_STATUS.ACTIVE ? 'ALREADY_ACTIVE' : 'ALREADY_INACTIVE');
    var c = coll('accounting_account_events'); if (!c) return fail('UNAVAILABLE');
    var kind = to === ACCOUNT_STATUS.ACTIVE ? 'activated' : 'deactivated';
    var w = c.append('eventId', { eventId:newId('AAE'), accountId:accountId, kind:kind, at:Date.now(),
      by:{ id:a.id, name:a.name }, reason:reason || null });
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit(to === ACCOUNT_STATUS.ACTIVE ? 'accounting.account_activated' : 'accounting.account_deactivated', a, {
      key:w.record.eventId, previousState:acc.status, newState:to, reason:reason || null,
      metadata:{ accountId:accountId, code:acc.code } });
    return { ok:true, account:copy(accountById(accountId)) };
  }
  function activateAccount(accountId, input){ if (RETIRED[accountId]) return fail('ACCOUNT_RETIRED'); return setStatus(accountId, ACCOUNT_STATUS.ACTIVE, input); }
  function deactivateAccount(accountId, input){ return setStatus(accountId, ACCOUNT_STATUS.INACTIVE, input); }

  function listAccounts(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['type', 'status']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = actor(P.VIEW); if (!a.ok) return a;
    var items = chart().filter(function (x) {
      if (filters.type && x.type !== filters.type) return false;
      if (filters.status && x.status !== filters.status) return false;
      return true;
    }).sort(function (x, y) { return String(x.code).localeCompare(String(y.code), 'en', { numeric:true }); });
    return { ok:true, items:copy(items) };
  }
  function getAccount(accountId){
    var a = actor(P.VIEW); if (!a.ok) return a;
    var acc = accountById(accountId); if (!acc) return fail('ACCOUNT_NOT_FOUND');
    return { ok:true, account:copy(acc) };
  }

  /* ══════════════════════ ACCOUNTING PERIODS ══════════════════════ */
  function periodRows(){ var c = coll('accounting_periods'); return c ? c.all() : []; }
  function periodEventRows(){ var c = coll('accounting_period_events'); return c ? c.all() : []; }
  function periods(){
    var closed = {};
    periodEventRows().forEach(function (e) {
      if (e.kind === 'closed' && (!closed[e.periodId] || (e.seq || 0) < (closed[e.periodId].seq || 0))) closed[e.periodId] = e;
    });
    return periodRows().map(function (r) {
      var c = closed[r.periodId] || null;
      return { periodId:r.periodId, startDate:r.startDate, endDate:r.endDate,
               status:c ? PERIOD_STATUS.CLOSED : PERIOD_STATUS.OPEN,
               createdAt:r.createdAt, createdBy:r.createdBy || null,
               closedAt:c ? c.at : null, closedBy:c ? c.by : null, closeReason:c ? (c.reason || null) : null };
    }).sort(function (x, y) { return x.startDate < y.startDate ? -1 : x.startDate > y.startDate ? 1 : 0; });
  }
  function periodById(id){ return periods().filter(function (p) { return p.periodId === id; })[0] || null; }
  function periodOfDate(d){ return periods().filter(function (p) { return p.startDate <= d && d <= p.endDate; })[0] || null; }

  function createPeriod(input){
    var a = actor(P.MANAGE); if (!a.ok) return a;
    if (!isObj(input)) return fail('INVALID');
    var bad = badKeys(input, ['startDate', 'endDate']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    if (!isDate(input.startDate) || !isDate(input.endDate)) return fail('DATE_INVALID');
    if (input.endDate < input.startDate) return fail('PERIOD_RANGE_INVALID');
    function overlap(){
      return periods().filter(function (p) { return input.startDate <= p.endDate && p.startDate <= input.endDate; })[0] || null;
    }
    var o = overlap(); if (o) return fail('PERIOD_OVERLAP', { periodId:o.periodId });
    var c = coll('accounting_periods'); if (!c) return fail('UNAVAILABLE');
    var id = 'AP-' + input.startDate.replace(/-/g, '') + '-' + input.endDate.replace(/-/g, '');
    o = overlap(); if (o) return fail('PERIOD_OVERLAP', { periodId:o.periodId });   /* re-check right before writing */
    var w = c.append('periodId', { periodId:id, startDate:input.startDate, endDate:input.endDate,
      createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:1 });
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('accounting.period_created', a, { key:id, newState:PERIOD_STATUS.OPEN,
      metadata:{ periodId:id, startDate:input.startDate, endDate:input.endDate } });
    return { ok:true, period:copy(periodById(id)) };
  }
  function closePeriod(periodId, input){
    var a = actor(P.CLOSE); if (!a.ok) return a;
    input = input || {};
    if (!isObj(input)) return fail('INVALID');
    var bad = badKeys(input, ['reason']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var reason = text(input.reason); if (reason.length > LIMITS.reason) return fail('INVALID', { field:'reason' });
    var p = periodById(periodId); if (!p) return fail('PERIOD_NOT_FOUND');
    if (p.status === PERIOD_STATUS.CLOSED) return fail('PERIOD_CLOSED');
    var c = coll('accounting_period_events'); if (!c) return fail('UNAVAILABLE');
    /* one closure per period: the event id is the period's own */
    var w = c.append('eventId', { eventId:'APE|' + periodId + '|closed', periodId:periodId, kind:'closed',
      at:Date.now(), by:{ id:a.id, name:a.name }, reason:reason || null });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return fail('PERIOD_CLOSED');
    audit('accounting.period_closed', a, { key:periodId, previousState:PERIOD_STATUS.OPEN, newState:PERIOD_STATUS.CLOSED,
      reason:reason || null, metadata:{ periodId:periodId, startDate:p.startDate, endDate:p.endDate } });
    return { ok:true, period:copy(periodById(periodId)) };
  }
  function listPeriods(){
    var a = actor(P.VIEW); if (!a.ok) return a;
    return { ok:true, items:copy(periods()) };
  }
  function getPeriod(periodId){
    var a = actor(P.VIEW); if (!a.ok) return a;
    var p = periodById(periodId); if (!p) return fail('PERIOD_NOT_FOUND');
    return { ok:true, period:copy(p) };
  }
  function periodFor(date){
    var a = actor(P.VIEW); if (!a.ok) return a;
    if (!isDate(date)) return fail('DATE_INVALID');
    var p = periodOfDate(date);
    return p ? { ok:true, period:copy(p) } : fail('NO_PERIOD', { date:date });
  }

  /* ══════════════════════ JOURNAL ENTRIES ══════════════════════ */
  function journalRows(){ var c = coll('accounting_journals'); return c ? c.all() : []; }
  function sourceKey(s){ return s && s.ref ? s.system + ':' + s.ref : null; }
  /* what makes two postings "the same entry" for idempotency */
  function fingerprint(e){
    return JSON.stringify([e.date, e.description, e.lines.map(function (l) { return [l.accountId, l.debit, l.credit, l.memo || null, l.ref || null]; })]);
  }

  /* validates a candidate entry completely, before anything is written */
  function validateEntry(input){
    if (!isObj(input)) return fail('INVALID');
    var bad = badKeys(input, ['journalId', 'date', 'description', 'source', 'lines']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    if (input.journalId !== undefined && !(typeof input.journalId === 'string' && /^JE-[A-Za-z0-9-]{3,60}$/.test(input.journalId))) return fail('JOURNAL_ID_INVALID');
    if (!isDate(input.date)) return fail('DATE_INVALID');
    var description = text(input.description);
    if (!description) return fail('DESCRIPTION_REQUIRED');
    if (description.length > LIMITS.description) return fail('INVALID', { field:'description' });
    var src = input.source;
    if (!isObj(src) || badKeys(src, ['system', 'ref']).length || SOURCES.indexOf(src.system) < 0) return fail('SOURCE_INVALID');
    var ref = src.ref == null ? null : (typeof src.ref === 'string' ? src.ref.trim() : undefined);
    if (ref === undefined || (ref !== null && (!ref || ref.length > LIMITS.ref))) return fail('SOURCE_INVALID');
    if (src.system !== 'manual' && !ref) return fail('SOURCE_REF_REQUIRED');
    if (!Array.isArray(input.lines) || input.lines.length < 2) return fail('TOO_FEW_LINES');
    if (input.lines.length > LIMITS.lines) return fail('INVALID', { field:'lines' });

    var errors = [], lines = [], dr = 0, cr = 0;
    var accs = {}; chart().forEach(function (x) { accs[x.accountId] = x; });
    input.lines.forEach(function (l, i) {
      var e = [];
      if (!isObj(l) || badKeys(l, ['accountId', 'debit', 'credit', 'memo', 'ref']).length) { errors.push({ line:i, code:'FIELD_NOT_ACCEPTED' }); return; }
      var acc = accs[l.accountId];
      if (!acc) e.push('ACCOUNT_NOT_FOUND');
      else {
        if (RETIRED[acc.accountId]) e.push('ACCOUNT_RETIRED');
        /* customer wallet funds (2200) move only through their own flows —
           wallet funding, refunds to the wallet, order settlement — never a
           manual or expense journal (no use as RAF cash / expenses / transfers) */
        if (CUSTOMER_FUNDS[acc.accountId] && CUSTOMER_FUNDS[acc.accountId].indexOf(src.system) < 0) e.push('CUSTOMER_FUNDS_RESTRICTED');
        if (acc.status !== ACCOUNT_STATUS.ACTIVE) e.push('ACCOUNT_INACTIVE');
        if (!acc.postable) e.push('ACCOUNT_NOT_POSTABLE');
      }
      var d = l.debit === undefined ? 0 : l.debit, c = l.credit === undefined ? 0 : l.credit;
      if (!isFils(d) || !isFils(c)) e.push('AMOUNT_INVALID');            /* negative, fractional, string, NaN, unsafe */
      else if (d > 0 && c > 0) e.push('BOTH_SIDES');
      else if (d === 0 && c === 0) e.push('ZERO_LINE');
      var memo = l.memo === undefined ? null : (typeof l.memo === 'string' ? l.memo.trim() : undefined);
      var lref = l.ref === undefined ? null : (typeof l.ref === 'string' ? l.ref.trim() : undefined);
      if (memo === undefined || (memo && memo.length > LIMITS.memo)) e.push('MEMO_INVALID');
      if (lref === undefined || (lref && lref.length > LIMITS.ref)) e.push('REF_INVALID');
      if (e.length) { e.forEach(function (code) { errors.push({ line:i, code:code }); }); return; }
      dr += d; cr += c;
      lines.push({ accountId:l.accountId, debit:d, credit:c, memo:memo || null, ref:lref || null });
    });
    if (errors.length) return fail('LINES_INVALID', { errors:errors });
    if (!Number.isSafeInteger(dr) || !Number.isSafeInteger(cr)) return fail('INVALID', { field:'total' });
    if (dr !== cr) return fail('UNBALANCED', { totalDebit:dr, totalCredit:cr });
    return { ok:true, entry:{ journalId:input.journalId || null, date:input.date, description:description,
      source:{ system:src.system, ref:ref }, lines:lines, total:dr } };
  }

  /* the complete check postJournal() makes — permission, entry, period,
     idempotency — WITHOUT writing anything, so an integration can prove that
     every entry of a multi-entry posting will be accepted before it posts the
     first one. A replay of an already-posted reference answers duplicate. */
  function validateJournal(input){
    var a = actor(P.POST); if (!a.ok) return a;
    var v = validateEntry(input); if (!v.ok) return v;
    var e = v.entry;
    var p = periodOfDate(e.date);
    if (!p) return fail('NO_PERIOD', { date:e.date });
    if (p.status !== PERIOD_STATUS.OPEN) return fail('PERIOD_CLOSED', { periodId:p.periodId });
    var rows = journalRows(), sk = sourceKey(e.source);
    if (sk) {
      var prior = rows.filter(function (j) { return sourceKey(j.source) === sk; })[0];
      if (prior) return fingerprint(prior) === fingerprint(e)
        ? { ok:true, duplicate:true, journalId:prior.journalId }
        : fail('SOURCE_CONFLICT', { journalId:prior.journalId });
    }
    if (e.journalId && rows.some(function (j) { return j.journalId === e.journalId; })) return fail('JOURNAL_EXISTS', { journalId:e.journalId });
    return { ok:true, duplicate:false, periodId:p.periodId, total:e.total };
  }

  function postJournal(input){
    var a = actor(P.POST); if (!a.ok) return a;
    var v = validateEntry(input); if (!v.ok) return v;
    var e = v.entry;
    var p = periodOfDate(e.date);
    if (!p) return fail('NO_PERIOD', { date:e.date });
    if (p.status !== PERIOD_STATUS.OPEN) return fail('PERIOD_CLOSED', { periodId:p.periodId });

    var rows = journalRows();
    /* idempotency: one entry per source reference */
    var sk = sourceKey(e.source);
    if (sk) {
      var prior = rows.filter(function (j) { return sourceKey(j.source) === sk; })[0];
      if (prior) {
        return fingerprint(prior) === fingerprint(e)
          ? { ok:true, duplicate:true, journal:copy(prior) }
          : fail('SOURCE_CONFLICT', { journalId:prior.journalId });
      }
    }
    if (e.journalId && rows.some(function (j) { return j.journalId === e.journalId; })) return fail('JOURNAL_EXISTS', { journalId:e.journalId });

    var c = coll('accounting_journals'); if (!c) return fail('UNAVAILABLE');
    var id = e.journalId || newId('JE');
    var rec = {
      journalId:id, date:e.date, periodId:p.periodId, description:e.description,
      source:e.source, status:JOURNAL_STATUS.POSTED,
      lines:e.lines.map(function (l, i) { return Object.assign({ lineId:id + '-L' + (i + 1), lineNo:i + 1 }, l); }),
      totalDebit:e.total, totalCredit:e.total,
      createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:1
    };
    /* re-check the facts that another tab could have changed meanwhile */
    var p2 = periodById(p.periodId);
    if (!p2 || p2.status !== PERIOD_STATUS.OPEN) return fail('PERIOD_CLOSED', { periodId:p.periodId });
    var rows2 = journalRows();
    if (rows2.some(function (j) { return j.journalId === id; })) return fail('JOURNAL_EXISTS', { journalId:id });
    if (sk && rows2.some(function (j) { return sourceKey(j.source) === sk; })) return fail('SOURCE_CONFLICT');
    var w = c.append('journalId', rec);
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('accounting.journal_posted', a, { key:id, newState:JOURNAL_STATUS.POSTED,
      metadata:{ journalId:id, periodId:p.periodId, date:e.date, totalFils:e.total, lineCount:e.lines.length,
                 sourceSystem:e.source.system, sourceRef:e.source.ref } });
    return { ok:true, journal:copy(w.record) };
  }

  /* for the RAF domains that will feed the record later (none connected yet):
     the same validation and permission, with a mandatory stable reference */
  function postFromSource(system, ref, entry){
    if (system === 'manual') return fail('SOURCE_INVALID');
    if (!isObj(entry) || entry.source !== undefined) return fail('FIELD_NOT_ACCEPTED', { fields:['source'] });
    return postJournal(Object.assign({}, entry, { source:{ system:system, ref:ref } }));
  }

  function rangeOf(opts){
    opts = opts || {};
    if (!isObj(opts)) return fail('INVALID');
    var bad = badKeys(opts, ['periodId', 'from', 'to']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    if (opts.periodId !== undefined) {
      if (opts.from !== undefined || opts.to !== undefined) return fail('FIELD_NOT_ACCEPTED', { fields:['from', 'to'] });
      var p = periodById(opts.periodId); if (!p) return fail('PERIOD_NOT_FOUND');
      return { ok:true, from:p.startDate, to:p.endDate, periodId:p.periodId };
    }
    if (opts.from !== undefined && !isDate(opts.from)) return fail('DATE_INVALID');
    if (opts.to !== undefined && !isDate(opts.to)) return fail('DATE_INVALID');
    if (opts.from && opts.to && opts.to < opts.from) return fail('PERIOD_RANGE_INVALID');
    return { ok:true, from:opts.from || null, to:opts.to || null, periodId:null };
  }
  function byDateSeq(x, y){ return x.date < y.date ? -1 : x.date > y.date ? 1 : (x.seq || 0) - (y.seq || 0); }

  function listJournals(filters){
    filters = filters || {};
    if (!isObj(filters)) return fail('INVALID');
    var bad = badKeys(filters, ['periodId', 'from', 'to', 'accountId', 'system']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = actor(P.VIEW); if (!a.ok) return a;
    var r = rangeOf({ periodId:filters.periodId, from:filters.from, to:filters.to });
    if (!r.ok) return r;
    var items = journalRows().filter(function (j) {
      if (r.from && j.date < r.from) return false;
      if (r.to && j.date > r.to) return false;
      if (filters.system && j.source.system !== filters.system) return false;
      if (filters.accountId && !j.lines.some(function (l) { return l.accountId === filters.accountId; })) return false;
      return true;
    }).sort(byDateSeq);
    return { ok:true, items:copy(items) };
  }
  function getJournal(journalId){
    var a = actor(P.VIEW); if (!a.ok) return a;
    var j = journalRows().filter(function (x) { return x.journalId === journalId; })[0];
    return j ? { ok:true, journal:copy(j) } : fail('JOURNAL_NOT_FOUND');
  }
  function journalBySource(system, ref){
    var a = actor(P.VIEW); if (!a.ok) return a;
    var k = SOURCES.indexOf(system) > -1 && typeof ref === 'string' && ref.trim() ? system + ':' + ref.trim() : null;
    if (!k) return fail('SOURCE_INVALID');
    var j = journalRows().filter(function (x) { return sourceKey(x.source) === k; })[0];
    return j ? { ok:true, journal:copy(j) } : fail('JOURNAL_NOT_FOUND');
  }

  /* ══════════════════════ GENERAL LEDGER (derived) ══════════════════════
     Integer arithmetic only. A balance is reported on the account's normal
     side (positive = the normal side) together with the raw debit/credit
     figures it comes from. */
  function signed(acc, dr, cr){ return acc.normalBalance === 'debit' ? dr - cr : cr - dr; }
  function sideOf(acc, bal){ return bal === 0 ? null : (bal > 0 ? acc.normalBalance : (acc.normalBalance === 'debit' ? 'credit' : 'debit')); }

  function ledger(accountId, opts){
    var a = actor(P.VIEW); if (!a.ok) return a;
    var acc = accountById(accountId); if (!acc) return fail('ACCOUNT_NOT_FOUND');
    var r = rangeOf(opts); if (!r.ok) return r;
    var openDr = 0, openCr = 0, dr = 0, cr = 0, lines = [];
    journalRows().slice().sort(byDateSeq).forEach(function (j) {
      j.lines.forEach(function (l) {
        if (l.accountId !== accountId) return;
        if (r.from && j.date < r.from) { openDr += l.debit; openCr += l.credit; return; }
        if (r.to && j.date > r.to) return;
        dr += l.debit; cr += l.credit;
        lines.push({ journalId:j.journalId, lineId:l.lineId, date:j.date, periodId:j.periodId, description:j.description,
                     memo:l.memo, ref:l.ref, source:copy(j.source), debit:l.debit, credit:l.credit });
      });
    });
    var opening = signed(acc, openDr, openCr), closing = signed(acc, openDr + dr, openCr + cr), run = opening;
    lines.forEach(function (l) { run += signed(acc, l.debit, l.credit); l.balance = run; });
    return { ok:true, account:{ accountId:acc.accountId, code:acc.code, nameAr:acc.nameAr, nameEn:acc.nameEn,
               type:acc.type, normalBalance:acc.normalBalance, status:acc.status },
             from:r.from, to:r.to, periodId:r.periodId,
             openingBalance:opening, openingSide:sideOf(acc, opening),
             periodDebits:dr, periodCredits:cr,
             closingBalance:closing, closingSide:sideOf(acc, closing),
             lines:lines };
  }

  /* ══════════════════════ TRIAL BALANCE (derived) ══════════════════════
     For each account with activity up to the end of the range: the range's
     debit and credit movement, and the resulting (closing) balance placed in
     its debit or credit column. Both column pairs must agree. */
  function trialBalance(opts){
    var a = actor(P.VIEW); if (!a.ok) return a;
    var r = rangeOf(opts); if (!r.ok) return r;
    var acc = {}; chart().forEach(function (x) { acc[x.accountId] = x; });
    var t = {};
    journalRows().forEach(function (j) {
      if (r.to && j.date > r.to) return;
      var inRange = !r.from || j.date >= r.from;
      j.lines.forEach(function (l) {
        var x = t[l.accountId] = t[l.accountId] || { odr:0, ocr:0, dr:0, cr:0 };
        if (inRange) { x.dr += l.debit; x.cr += l.credit; } else { x.odr += l.debit; x.ocr += l.credit; }
      });
    });
    var rows = Object.keys(t).map(function (id) {
      var x = t[id], ac = acc[id] || { accountId:id, code:null, nameAr:null, nameEn:null, type:null, normalBalance:'debit' };
      var net = (x.odr + x.dr) - (x.ocr + x.cr);                    /* debit-positive */
      var bal = signed(ac, x.odr + x.dr, x.ocr + x.cr);
      return { accountId:id, code:ac.code, nameAr:ac.nameAr, nameEn:ac.nameEn, type:ac.type, normalBalance:ac.normalBalance,
               openingDebit:x.odr, openingCredit:x.ocr, debit:x.dr, credit:x.cr,
               balance:bal, balanceSide:sideOf(ac, bal),
               closingDebit:net > 0 ? net : 0, closingCredit:net < 0 ? -net : 0 };
    }).sort(function (x, y) { return String(x.code).localeCompare(String(y.code), 'en', { numeric:true }); });
    var tot = { debit:0, credit:0, closingDebit:0, closingCredit:0 };
    rows.forEach(function (x) { tot.debit += x.debit; tot.credit += x.credit; tot.closingDebit += x.closingDebit; tot.closingCredit += x.closingCredit; });
    return { ok:true, from:r.from, to:r.to, periodId:r.periodId, rows:rows, totals:tot,
             balanced:tot.debit === tot.credit && tot.closingDebit === tot.closingCredit };
  }

  /* ══════════════════════ CAPABILITIES ══════════════════════ */
  function capabilities(){
    var v = actor(P.VIEW);
    if (!v.ok && v.code !== 'FORBIDDEN') return { ok:false, code:v.code, message:v.message, view:false };
    return { ok:true, view:v.ok, post:can(P.POST), manage:can(P.MANAGE), close:can(P.CLOSE) };
  }
  function typeLabel(type){ var x = TYPE_TXT[type]; return x ? T(x.ar, x.en) : null; }

  global.RAFAccounting = {
    VERSION:VERSION, PERMISSIONS:P, TYPES:TYPES.slice(), NORMAL_BALANCE:copy(NORMAL), TYPE_TXT:copy(TYPE_TXT),
    ACCOUNT_STATUS:ACCOUNT_STATUS, PERIOD_STATUS:PERIOD_STATUS, JOURNAL_STATUS:JOURNAL_STATUS,
    SOURCES:SOURCES.slice(), LIMITS:LIMITS, ERRORS:ERRORS, FOUNDATION:copy(FOUNDATION),
    /* helpers (pure) */
    todayKuwait:todayKuwait, kuwaitDateOf:kuwaitDateOf, isDate:isDate, isFils:isFils, typeLabel:typeLabel, nameOf:nameOf,
    capabilities:capabilities,
    /* chart of accounts */
    installFoundation:installFoundation, createAccount:createAccount,
    activateAccount:activateAccount, deactivateAccount:deactivateAccount,
    listAccounts:listAccounts, getAccount:getAccount,
    /* periods */
    createPeriod:createPeriod, closePeriod:closePeriod, listPeriods:listPeriods, getPeriod:getPeriod, periodFor:periodFor,
    /* journal entries */
    postJournal:postJournal, postFromSource:postFromSource, validateJournal:validateJournal,
    listJournals:listJournals, getJournal:getJournal, journalBySource:journalBySource,
    /* derived projections */
    ledger:ledger, trialBalance:trialBalance
  };
})(window);
