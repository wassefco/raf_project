/* ============================================================================
 * RAF Marketplace — RBAC (Role-Based Access Control) Core
 * ----------------------------------------------------------------------------
 * Prototype data layer + enforcement helper.
 *
 * DESIGN GOALS
 *  - Backend-ready: every entity maps 1:1 to a SQL table so this prototype can
 *    migrate to Supabase / PostgreSQL / Firebase / a custom API WITHOUT redesign.
 *  - Stable permission KEYS (e.g. "orders.refund"). The SAME keys are intended
 *    to drive backend enforcement (RLS policies / middleware), not just the UI.
 *  - Effective permission resolution:
 *        can(user, key) = (role.permissions ∪ user.grants) − user.revokes
 *
 * SUGGESTED RELATIONAL MAPPING
 *   raf_perm_catalog   -> permissions(key PK, module, action, label_ar, label_en)
 *   raf_roles          -> roles(id PK, name_ar, name_en, description, is_system)
 *                         role_permissions(role_id FK, permission_key FK)
 *   raf_users          -> users(id PK, name, email, phone, account_type,
 *                                status, reg_date, role_id FK)
 *                         user_permission_overrides(user_id FK, permission_key FK,
 *                                                   effect ENUM('grant','revoke'))
 *   raf_templates      -> permission_templates(id PK, name_ar, name_en, description)
 *                         template_permissions(template_id FK, permission_key FK)
 *
 * SECURITY NOTE
 *   Frontend hiding (RAFPerm.enforce) is convenience ONLY. Real enforcement must
 *   also happen server-side: check can(user,key) inside every API endpoint / RLS
 *   policy before returning or mutating data. Direct-URL / direct-API access must
 *   be rejected by the backend using these same permission keys.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* -------------------------------------------------------------------------
   * 1) PERMISSION CATALOG  (modules -> actions -> stable keys)
   * ---------------------------------------------------------------------- */
  var MODULES = [
    { id: 'users',       labelAr: 'المستخدمون',       labelEn: 'Users',                icon: 'ti-users',
      actions: ['view', 'create', 'edit', 'delete', 'suspend'] },
    { id: 'stores',      labelAr: 'المتاجر',          labelEn: 'Stores',               icon: 'ti-building-store',
      actions: ['view', 'approve', 'edit', 'delete'] },
    { id: 'products',    labelAr: 'المنتجات',         labelEn: 'Products',             icon: 'ti-box',
      actions: ['view', 'create', 'edit', 'delete'] },
    { id: 'orders',      labelAr: 'الطلبات',          labelEn: 'Orders',               icon: 'ti-shopping-bag',
      actions: ['view', 'manage', 'cancel', 'refund'] },
    { id: 'auctions',    labelAr: 'المزادات',         labelEn: 'Auctions',             icon: 'ti-gavel',
      actions: ['view', 'create', 'edit', 'delete', 'approve'] },
    { id: 'offers',      labelAr: 'العروض',           labelEn: 'Offers',               icon: 'ti-discount',
      actions: ['view', 'create', 'edit', 'delete'] },
    { id: 'drivers',     labelAr: 'السائقون',         labelEn: 'Drivers',              icon: 'ti-motorbike',
      actions: ['view', 'approve', 'suspend'] },
    { id: 'reports',     labelAr: 'التقارير',         labelEn: 'Reports',              icon: 'ti-chart-bar',
      actions: ['view', 'export'] },
    { id: 'settings',    labelAr: 'إعدادات النظام',   labelEn: 'System Settings',      icon: 'ti-settings',
      actions: ['view', 'edit'] },
    { id: 'permissions', labelAr: 'إدارة الصلاحيات',  labelEn: 'Permissions Mgmt',     icon: 'ti-shield-lock',
      actions: ['view', 'edit'] }
  ];

  var ACTION_LABELS = {
    view:    { ar: 'عرض',      en: 'View' },
    create:  { ar: 'إنشاء',    en: 'Create' },
    edit:    { ar: 'تعديل',    en: 'Edit' },
    delete:  { ar: 'حذف',      en: 'Delete' },
    suspend: { ar: 'إيقاف',    en: 'Suspend' },
    approve: { ar: 'اعتماد',   en: 'Approve' },
    manage:  { ar: 'إدارة',    en: 'Manage' },
    cancel:  { ar: 'إلغاء',    en: 'Cancel' },
    refund:  { ar: 'استرجاع',  en: 'Refund' },
    export:  { ar: 'تصدير',    en: 'Export' }
  };

  function buildCatalog() {
    var cat = [];
    MODULES.forEach(function (m) {
      m.actions.forEach(function (a) {
        var al = ACTION_LABELS[a] || { ar: a, en: a };
        cat.push({
          key: m.id + '.' + a,
          module: m.id,
          action: a,
          labelAr: al.ar + ' ' + m.labelAr,
          labelEn: al.en + ' ' + m.labelEn
        });
      });
    });
    return cat;
  }
  var CATALOG = buildCatalog();
  var ALL_KEYS = CATALOG.map(function (p) { return p.key; });

  /* helper: collect every key for a list of modules */
  function keysFor(modules) {
    return CATALOG.filter(function (p) { return modules.indexOf(p.module) !== -1; })
                  .map(function (p) { return p.key; });
  }
  /* helper: only the read keys for a list of modules */
  function viewKeysFor(modules) {
    return modules.map(function (m) { return m + '.view'; });
  }

  /* -------------------------------------------------------------------------
   * 2) ROLES  (predefined — id is stable, used as foreign key)
   * ---------------------------------------------------------------------- */
  var ROLES = [
    {
      id: 'super_admin', nameAr: 'مدير عام', nameEn: 'Super Admin', system: true,
      descAr: 'صلاحيات كاملة على جميع وحدات النظام', descEn: 'Full unrestricted access to every module',
      permissions: ALL_KEYS.slice()
    },
    {
      id: 'higher_mgmt', nameAr: 'الإدارة العليا', nameEn: 'Higher Management', system: true,
      descAr: 'إشراف كامل عدا إدارة الصلاحيات الحساسة', descEn: 'Broad oversight, excludes sensitive permission edits',
      permissions: ALL_KEYS.filter(function (k) { return k !== 'permissions.edit' && k !== 'settings.edit'; })
    },
    {
      id: 'ops_manager', nameAr: 'مدير العمليات', nameEn: 'Operations Manager', system: true,
      descAr: 'إدارة الطلبات والمتاجر والسائقين والمنتجات', descEn: 'Runs orders, stores, drivers and products',
      permissions: keysFor(['orders', 'stores', 'drivers', 'products'])
        .concat(['users.view', 'reports.view', 'reports.export', 'auctions.view', 'offers.view'])
    },
    {
      id: 'customer_service', nameAr: 'خدمة العملاء', nameEn: 'Customer Service', system: true,
      descAr: 'متابعة الطلبات ودعم العملاء', descEn: 'Handles orders and customer support',
      permissions: ['users.view', 'orders.view', 'orders.manage', 'orders.cancel',
                    'stores.view', 'products.view', 'drivers.view', 'auctions.view', 'offers.view']
    },
    {
      id: 'finance', nameAr: 'المالية', nameEn: 'Finance', system: true,
      descAr: 'المدفوعات والاستردادات والتقارير المالية', descEn: 'Payments, refunds and financial reporting',
      permissions: ['orders.view', 'orders.refund', 'reports.view', 'reports.export',
                    'stores.view', 'users.view']
    },
    {
      id: 'marketing', nameAr: 'التسويق', nameEn: 'Marketing', system: true,
      descAr: 'إدارة العروض والمزادات والحملات', descEn: 'Manages offers, auctions and campaigns',
      permissions: keysFor(['offers', 'auctions'])
        .concat(['products.view', 'stores.view', 'reports.view'])
    },
    {
      id: 'merchant', nameAr: 'تاجر', nameEn: 'Merchant', system: true,
      descAr: 'إدارة متجره ومنتجاته وطلباته', descEn: 'Owns a store: products and own orders',
      permissions: ['stores.view', 'stores.edit', 'products.view', 'products.create',
                    'products.edit', 'products.delete', 'orders.view', 'orders.manage',
                    'offers.view', 'offers.create', 'offers.edit', 'offers.delete',
                    'auctions.view', 'auctions.create', 'reports.view']
    },
    {
      id: 'merchant_employee', nameAr: 'موظف تاجر', nameEn: 'Merchant Employee', system: true,
      descAr: 'مساعدة التاجر بصلاحيات محدودة', descEn: 'Assists a merchant with limited scope',
      permissions: ['stores.view', 'products.view', 'products.create', 'products.edit',
                    'orders.view', 'orders.manage', 'offers.view']
    },
    {
      id: 'driver', nameAr: 'سائق', nameEn: 'Driver', system: true,
      descAr: 'استلام وتوصيل الطلبات المسندة', descEn: 'Receives and delivers assigned orders',
      permissions: ['orders.view']
    },
    {
      id: 'customer', nameAr: 'عميل', nameEn: 'Customer', system: true,
      descAr: 'مستخدم عادي بدون صلاحيات إدارية', descEn: 'Standard shopper, no admin access',
      permissions: []
    }
  ];

  /* -------------------------------------------------------------------------
   * 3) USERS  (18 seeded — reflects the RAF org structure)
   * ---------------------------------------------------------------------- */
  function u(id, name, email, phone, accountType, roleId, status, regDate, overrides) {
    return {
      id: id, name: name, email: email, phone: phone,
      accountType: accountType, roleId: roleId, status: status,
      regDate: regDate, overrides: overrides || {}
    };
  }
  var USERS = [
    /* 1 Super Admin */
    u('usr-001', 'أحمد المنصور', 'a.mansour@raf.kw', '+965 9000 1001', 'staff', 'super_admin', 'active', '2023-01-05'),
    /* 2 Higher Management */
    u('usr-002', 'فاطمة العلي', 'f.ali@raf.kw', '+965 9000 1002', 'staff', 'higher_mgmt', 'active', '2023-02-12'),
    u('usr-003', 'عبدالله الراشد', 'a.rashed@raf.kw', '+965 9000 1003', 'staff', 'higher_mgmt', 'active', '2023-03-01'),
    /* 2 Operations */
    u('usr-004', 'يوسف البدر', 'y.badr@raf.kw', '+965 9000 1004', 'staff', 'ops_manager', 'active', '2023-04-18'),
    u('usr-005', 'منى الخالدي', 'm.khaled@raf.kw', '+965 9000 1005', 'staff', 'ops_manager', 'active', '2023-05-22',
      { 'auctions.approve': 'grant', 'orders.refund': 'revoke' }),
    /* 2 Customer Service */
    u('usr-006', 'سارة الفهد', 's.fahad@raf.kw', '+965 9000 1006', 'staff', 'customer_service', 'active', '2023-06-09'),
    u('usr-007', 'خالد العتيبي', 'k.otaibi@raf.kw', '+965 9000 1007', 'staff', 'customer_service', 'suspended', '2023-07-15'),
    /* 1 Finance */
    u('usr-008', 'نورة السالم', 'n.salem@raf.kw', '+965 9000 1008', 'staff', 'finance', 'active', '2023-08-03'),
    /* 1 Marketing */
    u('usr-009', 'فيصل المطيري', 'f.mutairi@raf.kw', '+965 9000 1009', 'staff', 'marketing', 'active', '2023-09-27'),
    /* 2 Merchants */
    u('usr-010', 'متجر كازا مود', 'casa.mode@raf.kw', '+965 9000 1010', 'merchant', 'merchant', 'active', '2023-10-11',
      { 'auctions.edit': 'grant' }),
    u('usr-011', 'متجر لمسة ذهب', 'lamset.gold@raf.kw', '+965 9000 1011', 'merchant', 'merchant', 'active', '2023-11-30'),
    /* 2 Merchant Employees */
    u('usr-012', 'ريم الدوسري', 'reem.d@casa.kw', '+965 9000 1012', 'merchant', 'merchant_employee', 'active', '2024-01-08'),
    u('usr-013', 'طلال الشمري', 'talal.s@lamset.kw', '+965 9000 1013', 'merchant', 'merchant_employee', 'active', '2024-02-19'),
    /* 2 Drivers */
    u('usr-014', 'ماجد العنزي', 'majed.driver@raf.kw', '+965 9000 1014', 'driver', 'driver', 'active', '2024-03-14'),
    u('usr-015', 'حمد القحطاني', 'hamad.driver@raf.kw', '+965 9000 1015', 'driver', 'driver', 'suspended', '2024-04-02'),
    /* 3 Customers */
    u('usr-016', 'محمد العنزي', 'm.anzi@gmail.com', '+965 9000 1016', 'customer', 'customer', 'active', '2024-05-21'),
    u('usr-017', 'دانة الصباح', 'dana.s@gmail.com', '+965 9000 1017', 'customer', 'customer', 'active', '2024-06-17'),
    u('usr-018', 'عبدالعزيز الحربي', 'a.harbi@gmail.com', '+965 9000 1018', 'customer', 'customer', 'active', '2024-07-09')
  ];

  /* -------------------------------------------------------------------------
   * 4) PERMISSION TEMPLATES  (reusable presets)
   * ---------------------------------------------------------------------- */
  var TEMPLATES = [
    {
      id: 'tpl_std_merchant', nameAr: 'تاجر قياسي', nameEn: 'Standard Merchant',
      descAr: 'صلاحيات المتجر والمنتجات والطلبات الأساسية', descEn: 'Core store, products and orders access',
      permissions: ['stores.view', 'stores.edit', 'products.view', 'products.create',
                    'products.edit', 'products.delete', 'orders.view', 'orders.manage', 'offers.view']
    },
    {
      id: 'tpl_senior_merchant', nameAr: 'تاجر متقدم', nameEn: 'Senior Merchant',
      descAr: 'صلاحيات التاجر القياسي مع العروض والمزادات', descEn: 'Standard merchant plus offers and auctions',
      permissions: ['stores.view', 'stores.edit', 'products.view', 'products.create', 'products.edit',
                    'products.delete', 'orders.view', 'orders.manage', 'offers.view', 'offers.create',
                    'offers.edit', 'offers.delete', 'auctions.view', 'auctions.create', 'reports.view']
    },
    {
      id: 'tpl_cs_agent', nameAr: 'موظف دعم عملاء', nameEn: 'Customer Support Agent',
      descAr: 'متابعة الطلبات ودعم المستخدمين', descEn: 'Order follow-up and user support',
      permissions: ['users.view', 'orders.view', 'orders.manage', 'orders.cancel',
                    'stores.view', 'products.view', 'drivers.view']
    },
    {
      id: 'tpl_finance_officer', nameAr: 'موظف مالية', nameEn: 'Finance Officer',
      descAr: 'الاستردادات والتقارير المالية', descEn: 'Refunds and financial reports',
      permissions: ['orders.view', 'orders.refund', 'reports.view', 'reports.export', 'users.view']
    },
    {
      id: 'tpl_regional_manager', nameAr: 'مدير إقليمي', nameEn: 'Regional Manager',
      descAr: 'إشراف على العمليات والمتاجر والسائقين', descEn: 'Oversees operations, stores and drivers',
      permissions: keysFor(['orders', 'stores', 'drivers'])
        .concat(['products.view', 'products.edit', 'users.view', 'reports.view', 'reports.export'])
    }
  ];

  /* -------------------------------------------------------------------------
   * 5) STORAGE  (seed-once; never clobber edited data)
   * ---------------------------------------------------------------------- */
  var LS = {
    catalog:   'raf_perm_catalog',
    roles:     'raf_roles',
    users:     'raf_users',
    templates: 'raf_templates',
    session:   'raf_current_user'   /* id of the acting staff member (demo) */
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function seed(force) {
    if (force || !localStorage.getItem(LS.catalog))   write(LS.catalog, CATALOG);
    else /* catalog is derived/static — always refresh to stay in sync */     write(LS.catalog, CATALOG);
    if (force || !localStorage.getItem(LS.roles))     write(LS.roles, ROLES);
    if (force || !localStorage.getItem(LS.users))     write(LS.users, USERS);
    if (force || !localStorage.getItem(LS.templates)) write(LS.templates, TEMPLATES);
    if (force || !localStorage.getItem(LS.session))   write(LS.session, 'usr-001');
  }

  /* -------------------------------------------------------------------------
   * 6) ACCESSORS
   * ---------------------------------------------------------------------- */
  function getCatalog()   { return read(LS.catalog, CATALOG); }
  function getModules()   { return MODULES.slice(); }
  function getRoles()     { return read(LS.roles, ROLES); }
  function getUsers()     { return read(LS.users, USERS); }
  function getTemplates() { return read(LS.templates, TEMPLATES); }

  function getRole(roleId) {
    return getRoles().filter(function (r) { return r.id === roleId; })[0] || null;
  }
  function getUser(userId) {
    return getUsers().filter(function (uu) { return uu.id === userId; })[0] || null;
  }
  function currentUser() {
    return getUser(read(LS.session, 'usr-001'));
  }

  function saveRole(role) {
    var roles = getRoles();
    var i = roles.findIndex(function (r) { return r.id === role.id; });
    if (i >= 0) roles[i] = role; else roles.push(role);
    write(LS.roles, roles);
  }
  function saveUser(user) {
    var users = getUsers();
    var i = users.findIndex(function (uu) { return uu.id === user.id; });
    if (i >= 0) users[i] = user; else users.push(user);
    write(LS.users, users);
  }
  function saveTemplate(tpl) {
    var tpls = getTemplates();
    var i = tpls.findIndex(function (t) { return t.id === tpl.id; });
    if (i >= 0) tpls[i] = tpl; else tpls.push(tpl);
    write(LS.templates, tpls);
  }
  function setCurrentUser(userId) { write(LS.session, userId); }

  /* -------------------------------------------------------------------------
   * 7) RESOLUTION  ——  can(user, key) = (role ∪ grants) − revokes
   * ---------------------------------------------------------------------- */
  function resolveUser(userOrId) {
    var user = (typeof userOrId === 'string') ? getUser(userOrId) : userOrId;
    if (!user) return null;
    return user;
  }

  /* origin of a permission for a user: 'role' | 'grant' | 'revoke' | 'none' */
  function originOf(userOrId, key) {
    var user = resolveUser(userOrId);
    if (!user) return 'none';
    var ov = user.overrides || {};
    if (ov[key] === 'revoke') return 'revoke';
    if (ov[key] === 'grant') return 'grant';
    var role = getRole(user.roleId);
    if (role && role.permissions.indexOf(key) !== -1) return 'role';
    return 'none';
  }

  function can(userOrId, key) {
    var o = originOf(userOrId, key);
    return o === 'role' || o === 'grant';
  }

  /* effective permission key list for a user */
  function effectivePermissions(userOrId) {
    var user = resolveUser(userOrId);
    if (!user) return [];
    var role = getRole(user.roleId);
    var set = {};
    (role ? role.permissions : []).forEach(function (k) { set[k] = true; });
    var ov = user.overrides || {};
    Object.keys(ov).forEach(function (k) {
      if (ov[k] === 'grant') set[k] = true;
      else if (ov[k] === 'revoke') delete set[k];
    });
    return Object.keys(set);
  }

  /* set / clear an override for a user (effect: 'grant' | 'revoke' | null) */
  function setOverride(userId, key, effect) {
    var user = getUser(userId);
    if (!user) return;
    user.overrides = user.overrides || {};
    if (effect === 'grant' || effect === 'revoke') user.overrides[key] = effect;
    else delete user.overrides[key];
    saveUser(user);
  }

  /* -------------------------------------------------------------------------
   * 8) FRONTEND ENFORCEMENT  (convenience only — back up server-side!)
   *    Usage in markup:
   *      <button data-perm="orders.refund"> ... </button>
   *      <section data-perm="reports.view"> ... </section>
   *      <body data-perm-guard="permissions.view" data-perm-redirect="raf_management.html">
   * ---------------------------------------------------------------------- */
  function enforce(userOrId) {
    var user = resolveUser(userOrId || read(LS.session, 'usr-001'));
    /* page-level guard */
    var guard = document.body ? document.body.getAttribute('data-perm-guard') : null;
    if (guard && user && !can(user, guard)) {
      var to = document.body.getAttribute('data-perm-redirect');
      if (to) { window.location = to; return; }
      document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif;color:#888;">'
        + '<h2>غير مصرّح بالوصول / Access Denied</h2>'
        + '<p>لا تملك صلاحية عرض هذه الصفحة.</p></div>';
      return;
    }
    /* element-level gating */
    document.querySelectorAll('[data-perm]').forEach(function (el) {
      var key = el.getAttribute('data-perm');
      var ok = user ? can(user, key) : false;
      el.style.display = ok ? '' : 'none';
    });
  }

  /* -------------------------------------------------------------------------
   * 9) PUBLIC API
   * ---------------------------------------------------------------------- */
  var RAFPerm = {
    LS: LS,
    MODULES: MODULES,
    ACTION_LABELS: ACTION_LABELS,
    seed: seed,
    reset: function () { seed(true); },
    /* accessors */
    getCatalog: getCatalog,
    getModules: getModules,
    getRoles: getRoles,
    getUsers: getUsers,
    getTemplates: getTemplates,
    getRole: getRole,
    getUser: getUser,
    currentUser: currentUser,
    setCurrentUser: setCurrentUser,
    /* mutators */
    saveRole: saveRole,
    saveUser: saveUser,
    saveTemplate: saveTemplate,
    setOverride: setOverride,
    /* resolution */
    can: can,
    originOf: originOf,
    effectivePermissions: effectivePermissions,
    /* enforcement */
    enforce: enforce
  };

  /* auto-seed on load so any page including this script has the data ready */
  seed(false);

  global.RAFPerm = RAFPerm;
})(window);
