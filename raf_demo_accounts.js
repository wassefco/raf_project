/* ============================================================================
 * RAF Marketplace — DEMO / QA ACCOUNTS  (testing only)
 * ----------------------------------------------------------------------------
 * Registers one active, verified account per RBAC role so the permission system
 * can be exercised end-to-end.
 *
 * Design constraints honoured:
 *   • Does NOT modify authentication, authorisation or RBAC logic.
 *   • Does NOT modify existing users, roles or permission definitions.
 *   • Writes exclusively through the public RAFPerm.saveUser() API.
 *   • Idempotent: every account has a stable `demo-*` id, so re-running this
 *     script UPDATES the existing demo account instead of creating duplicates.
 *   • Isolated: demo accounts are flagged `demo:true` and use the dedicated
 *     @demo.raf.kw domain, so they can never collide with real users and can be
 *     filtered or purged in one pass (RAFDemoAccounts.remove()).
 *
 * Roles are mapped onto the roles that already exist in raf_permissions.js —
 * no new role is created:
 *   Super Admin     → super_admin
 *   Admin           → higher_mgmt        (full oversight, no sensitive edits)
 *   Store Manager   → merchant           (owns a store)
 *   Store Employee  → merchant_employee
 *   Delivery Driver → driver
 *   Customer        → customer
 * ==========================================================================*/
(function (global) {
  'use strict';

  var CREATED = '2026-08-01';

  /* Passwords are strong and unique per account. NOTE: this prototype's login
     (raf_login.html) authenticates by email/phone and does not verify a
     password — adding verification would change auth logic, which is out of
     scope here. The value is stored so QA has a documented credential and so a
     future password check can read it without another migration. */
  var ACCOUNTS = [
    { id: 'demo-super-admin', name: 'Demo Super Admin',     nameAr: 'مدير عام تجريبي',
      email: 'super.admin@demo.raf.kw',    phone: '+965 9100 0001',
      accountType: 'staff',    roleId: 'super_admin',       password: 'Rf!SupAdm#2026$Kw7' },

    { id: 'demo-admin',       name: 'Demo Admin',           nameAr: 'مسؤول تجريبي',
      email: 'admin@demo.raf.kw',          phone: '+965 9100 0002',
      accountType: 'staff',    roleId: 'higher_mgmt',       password: 'Rf!Admin#2026$Kw3' },

    { id: 'demo-store-manager', name: 'Demo Store Manager', nameAr: 'مدير متجر تجريبي',
      email: 'store.manager@demo.raf.kw',  phone: '+965 9100 0003',
      accountType: 'merchant', roleId: 'merchant',          password: 'Rf!StrMgr#2026$Kw9' },

    { id: 'demo-store-employee', name: 'Demo Store Employee', nameAr: 'موظف متجر تجريبي',
      email: 'store.employee@demo.raf.kw', phone: '+965 9100 0004',
      accountType: 'merchant', roleId: 'merchant_employee', password: 'Rf!StrEmp#2026$Kw5' },

    { id: 'demo-driver',      name: 'Demo Delivery Driver', nameAr: 'سائق توصيل تجريبي',
      email: 'driver@demo.raf.kw',         phone: '+965 9100 0005',
      accountType: 'driver',   roleId: 'driver',            password: 'Rf!Driver#2026$Kw2' },

    { id: 'demo-customer',    name: 'Demo Customer',        nameAr: 'عميل تجريبي',
      email: 'customer@demo.raf.kw',       phone: '+965 9100 0006',
      accountType: 'customer', roleId: 'customer',          password: 'Rf!Cust#2026$Kw8' }
  ];

  /* Dashboard each role lands on — mirrors the map already used by the login
     page; kept here only for the QA summary table, not for routing. */
  var LANDING = {
    super_admin: 'raf_management.html', higher_mgmt: 'raf_management.html',
    merchant: 'raf_merchant.html', merchant_employee: 'raf_merchant.html',
    driver: 'raf_driver_app.html', customer: 'raf_account.html'
  };

  function toUser(a) {
    return {
      id: a.id,
      name: a.name,
      nameAr: a.nameAr,
      email: a.email,
      phone: a.phone,
      accountType: a.accountType,
      roleId: a.roleId,            /* permissions resolve from the existing role */
      status: 'active',            /* Active   */
      verified: true,              /* Verified */
      demo: true,                  /* isolation flag — never a real customer   */
      demoPassword: a.password,
      regDate: CREATED,
      overrides: {}                /* no per-user overrides: pure role behaviour */
    };
  }

  /* Install / refresh every demo account (upsert by stable id). */
  function install() {
    if (!global.RAFPerm || typeof RAFPerm.saveUser !== 'function') return { ok: false, reason: 'RAFPerm unavailable' };
    var roles = {};
    (RAFPerm.getRoles() || []).forEach(function (r) { roles[r.id] = r; });

    var report = [];
    ACCOUNTS.forEach(function (a) {
      if (!roles[a.roleId]) { report.push({ email: a.email, ok: false, reason: 'missing role ' + a.roleId }); return; }
      var existing = RAFPerm.getUser ? RAFPerm.getUser(a.id) : null;
      RAFPerm.saveUser(toUser(a));                 /* update when present, insert when not */
      report.push({ email: a.email, ok: true, action: existing ? 'updated' : 'created' });
    });
    return { ok: true, accounts: report };
  }

  /* Summary used by the QA table / console. */
  function list() {
    var roles = {};
    (global.RAFPerm ? RAFPerm.getRoles() : []).forEach(function (r) { roles[r.id] = r; });
    return ACCOUNTS.map(function (a) {
      var role = roles[a.roleId] || {};
      var u = global.RAFPerm && RAFPerm.getUser ? RAFPerm.getUser(a.id) : null;
      return {
        name: a.name,
        role: role.nameEn || a.roleId,
        roleId: a.roleId,
        email: a.email,
        password: a.password,
        status: u ? (u.status === 'active' ? 'Active' : u.status) : 'not installed',
        verified: u ? !!u.verified : false,
        permissions: (role.permissions || []).length,
        landing: LANDING[a.roleId] || 'raf_account.html'
      };
    });
  }

  /* Console-friendly table for QA. */
  function print() {
    var rows = list().map(function (r) {
      return { Name: r.name, Role: r.role, Email: r.email, Password: r.password,
               Status: r.status + (r.verified ? ' · Verified' : ''), Perms: r.permissions };
    });
    if (console.table) console.table(rows); else console.log(rows);
    return rows;
  }

  /* Remove every demo account (leaves real users untouched). */
  function remove() {
    if (!global.RAFPerm) return false;
    try {
      var kept = RAFPerm.getUsers().filter(function (u) { return !u.demo; });
      localStorage.setItem(RAFPerm.LS.users, JSON.stringify(kept));
      return true;
    } catch (e) { return false; }
  }

  var result = install();

  global.RAFDemoAccounts = {
    accounts: ACCOUNTS.map(function (a) { return a.email; }),
    install: install, list: list, print: print, remove: remove, result: result
  };
})(window);
