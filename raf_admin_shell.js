/* ============================================================================
 * RAF MANAGEMENT — SHARED SHELL  (RAFAdmin)
 * ----------------------------------------------------------------------------
 * The one implementation of what every RAF Management page shares, so no page
 * repeats (and drifts from) the access rules:
 *   · identity from this tab's session only (RAFPerm.sessionUserId), the
 *     suspended-account refusal and the sign-in / no-access gate
 *   · the permission-driven sidebar: RAF Management pages (same tab) and the
 *     other administrations (new tab), each listed only when the account
 *     passes the check that surface itself applies — never by role name
 *   · the header (title, identity, refresh, theme, language, sign out)
 *   · the light/dark theme and the Arabic/English switch (per-viewer
 *     preferences, saved only when the viewer presses the control)
 *   · the mobile drawer
 * It owns no business data and writes nothing on load.
 *
 * A page calls RAFAdmin.start({ active, title, canEnter, refresh }) and draws
 * its own content in refresh().
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFAdmin) return;

  var P = function(){ return global.RAFPerm || null; };
  var ME = null, CAP = { cs:null, lg:null }, OPTS = null;

  function root(){ return document.getElementById('htmlRoot'); }
  function isEn(){ return root().lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function L(o){ return (o && typeof o === 'object') ? (isEn() ? (o.en||o.ar) : (o.ar||o.en)) : (o||''); }
  function el(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function locale(){ return isEn() ? 'en-GB' : 'ar-KW-u-nu-latn'; }
  function clockOf(ms){
    if(!ms) return null;
    try { return new Date(ms).toLocaleString(locale(), { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kuwait' }); }
    catch(e){ return new Date(ms).toISOString().slice(0,16).replace('T',' '); }
  }
  function isoOf(ms){ try { return new Date(ms).toISOString(); } catch(e){ return ''; } }
  function can(key){ try { return !!(ME && P().can(ME.id, key)); } catch(e){ return false; } }
  /* every link that leaves RAF Management opens a new tab, keeping the opener
     so the tab-scoped session travels with it */
  var NEWTAB = ' target="_blank" rel="opener"';
  function srNew(){ return '<span class="sr-only">' + T(' (يفتح في علامة تبويب جديدة)',' (opens in a new tab)') + '</span>'; }
  function ext(){ return '<i class="ti ti-external-link nt" aria-hidden="true"></i>'; }

  /* ───────── the other administrations (department navigation, new tab) ─────────
     Only surfaces that EXIST, each listed when the account passes the same
     check that page applies on entry. */
  function readCaps(){
    var CS = global.RAFCustomerService, LG = global.RAFLogistics;
    try { CAP.cs = CS ? CS.capabilities() : null; } catch(e){ CAP.cs = null; }
    try { CAP.lg = LG ? LG.capabilities() : null; } catch(e){ CAP.lg = null; }
  }
  function logisticsOps(){ return can('orders.view') && can('drivers.view') && can('drivers.suspend'); }
  function driversView(){ return !!(CAP.lg && CAP.lg.ok && CAP.lg.view); }
  function csView(){ return !!(CAP.cs && CAP.cs.ok && CAP.cs.audience === 'employee' && CAP.cs.view); }
  var DEST = [
    { k:'logistics', icon:'ti-route', ar:'اللوجستيات', en:'Logistics',
      href:function(){ return logisticsOps() ? 'raf_logistics.html' : (driversView() ? 'raf_logistics_drivers.html' : null); } },
    { k:'cs', icon:'ti-headset', ar:'خدمة العملاء', en:'Customer Service',
      href:function(){ return csView() ? 'raf_customer_service.html' : null; } },
    { k:'perm', icon:'ti-shield-lock', ar:'إدارة الصلاحيات', en:'Permissions',
      href:function(){ return can('permissions.view') ? 'raf_permissions.html' : null; } }
  ];
  function destinations(){
    return DEST.map(function(d){ return { d:d, href:d.href() }; }).filter(function(x){ return !!x.href; });
  }
  /* RAF Management's own pages (same tab). Requests & Approvals is listed for
     an account that may view at least one request type — the central model
     answers from each type's existing permission. */
  function requestsView(){ try { return !!(global.RAFRequests && RAFRequests.canAccess()); } catch(e){ return false; } }
  /* Stores Management reads every store, so it is listed for an account that
     holds stores.view and is NOT store-scoped: a merchant account holds the
     same key for its own store only (RAFPerm.isMerchant decides that). */
  function storesView(){
    try { return can('stores.view') && !!ME && !P().isMerchant(ME.id); } catch(e){ return false; }
  }
  var PAGES = [
    { k:'home', icon:'ti-home-2', ar:'الرئيسية', en:'Home', href:'raf_admin.html', show:function(){ return true; } },
    { k:'requests', icon:'ti-checklist', ar:'الطلبات والموافقات', en:'Requests & Approvals', href:'raf_admin_requests.html', show:requestsView },
    { k:'stores', icon:'ti-building-store', ar:'إدارة المتاجر', en:'Stores Management', href:'raf_admin_stores.html', show:storesView }
  ];

  /* ───────── shell rendering ───────── */
  function renderNav(){
    var own = PAGES.filter(function(p){ return p.show(); }).map(function(p){
      return '<li><a href="' + p.href + '"' + (OPTS.active === p.k ? ' aria-current="page"' : '') + '><i class="ti ' + p.icon + '" aria-hidden="true"></i>'
        + '<span>' + esc(T(p.ar, p.en)) + '</span></a></li>';
    }).join('');
    var secs = destinations().map(function(x){
      return '<li><a href="' + esc(x.href) + '"' + NEWTAB + '><i class="ti ' + x.d.icon + '" aria-hidden="true"></i>'
        + '<span>' + esc(T(x.d.ar, x.d.en)) + '</span>' + srNew() + '<i class="ti ti-external-link ext" aria-hidden="true"></i></a></li>';
    }).join('');
    el('navTree').innerHTML =
      '<span class="grp">' + T('إدارة رف','RAF Management') + '</span><ul>' + own + '</ul>'
      + (secs ? '<span class="grp">' + T('الإدارات','Administrations') + '</span><ul>' + secs + '</ul>' : '');
    el('navTree').setAttribute('aria-label', T('التنقل','Navigation'));
    el('opsNav').setAttribute('aria-label', T('إدارة رف','RAF Management'));
  }
  function theme(){ return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function renderThemeBtn(){
    var dark = theme() === 'dark', b = el('themeBtn');
    if(!b) return;
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    b.setAttribute('aria-label', T('الوضع الداكن','Dark mode'));
    b.setAttribute('title', dark ? T('التبديل إلى الوضع الفاتح','Switch to light mode') : T('التبديل إلى الوضع الداكن','Switch to dark mode'));
    b.innerHTML = '<i class="ti ' + (dark ? 'ti-sun' : 'ti-moon') + '" aria-hidden="true"></i>';
  }
  function renderHeader(){
    el('crumbGroup').textContent = T('إدارة رف','RAF Management');
    el('crumbPage').textContent = T(OPTS.title.ar, OPTS.title.en);
    el('langBtn').textContent = isEn() ? 'ع' : 'EN';
    el('langBtn').setAttribute('aria-label', T('التبديل إلى الإنجليزية','Switch to Arabic'));
    el('refreshBtn').setAttribute('aria-label', T('تحديث','Refresh'));
    renderThemeBtn();
    document.querySelector('.ops-burger').setAttribute('aria-label', T('القائمة','Menu'));
    document.querySelector('.ops-nav-x').setAttribute('aria-label', T('إغلاق القائمة','Close menu'));
    el('userAv').textContent = String(ME.name || '?').trim().charAt(0);
    el('userName').textContent = ME.name || '';
    var role = null; try { role = P().getRole(ME.roleId); } catch(e){}
    el('userRole').textContent = role ? T(role.nameAr, role.nameEn) : '';
    document.title = T('رف — ' + OPTS.title.ar, 'RAF — ' + OPTS.title.en);
  }
  function refresh(){
    if(!ME) return;
    readCaps(); renderHeader(); renderNav();
    OPTS.refresh();
  }

  /* ───────── access ───────── */
  function gate(titleAr, titleEn, msgAr, msgEn, signIn){
    el('shell').hidden = true;
    el('gate').hidden = false;
    el('gateT').textContent = T(titleAr, titleEn);
    el('gateP').textContent = T(msgAr, msgEn);
    el('gateSignIn').hidden = !signIn;
    /* a signed-in account that is refused here can still end its session */
    el('gateSignOut').hidden = !!signIn || !(P() && P().sessionUserId && P().sessionUserId());
    document.title = T('رف — إدارة رف','RAF — RAF Management');
  }
  function applyLang(){
    var en = isEn();
    document.querySelectorAll('[data-ar][data-en]').forEach(function(e){
      var t = e.getAttribute('data-' + (en ? 'en' : 'ar')); if(t !== null) e.textContent = t;
    });
  }
  function boot(){
    var l = null; try { l = localStorage.getItem('raf_lang'); } catch(e){}
    if(l === 'en'){ root().lang = 'en'; root().dir = 'ltr'; }
    applyLang();
    if(!P() || !global.RAFAudit) return gate('تعذّر التحميل','Could not load','لم يتم تحميل وحدات رف المطلوبة.','The required RAF modules did not load.', false);
    /* identity from this tab's stored session only — never from the URL.
       RAFPerm.currentUser() falls back to an administrator when nothing is
       signed in, so the session key is read first and an empty one refused. */
    var sid = null; try { sid = P().sessionUserId ? P().sessionUserId() : null; } catch(e){ sid = null; }
    var u = null; if(sid){ try { u = P().getUser(sid); } catch(e){ u = null; } }
    if(!sid || !u) return gate('يلزم تسجيل الدخول','Sign-in required','إدارة رف متاحة لفريق رف بعد تسجيل الدخول.','RAF Management is available to RAF staff after signing in.', true);
    if(u.status !== 'active') return gate('حسابك موقوف','Your account is suspended','لا يمكن فتح إدارة رف بحساب موقوف.','A suspended account cannot open RAF Management.', false);
    ME = { id:u.id, name:u.name, roleId:u.roleId };
    readCaps();
    if(!OPTS.canEnter()){
      ME = null;
      var g = OPTS.denied || ['لا تملك صلاحية الوصول','You do not have access','لا يتيح حسابك أي قسم من أقسام إدارة رف.','Your account has access to no RAF Management section.'];
      return gate(g[0], g[1], g[2], g[3], false);
    }
    el('gate').hidden = true; el('shell').hidden = false;
    refresh();

    /* live updates through the mechanisms that already exist — no polling */
    var t = null;
    function soon(){ clearTimeout(t); t = setTimeout(refresh, 120); }
    if(global.RAFEventBus){
      ['support.*','audit.*','logistics.*','order.*'].forEach(function(p){ try { RAFEventBus.subscribe(p, soon); } catch(e){} });
    }
    document.addEventListener('raf:audit', soon);
    document.addEventListener('raf:source', soon);
    global.addEventListener('storage', function(e){
      if(e.key === 'raf_admin_theme' && (e.newValue === 'light' || e.newValue === 'dark')){ document.documentElement.setAttribute('data-theme', e.newValue); if(ME) renderThemeBtn(); return; }
      if(e.key && e.key.indexOf('raf_') === 0 && e.key !== 'raf_lang') soon();
    });
    if(OPTS.onReady) OPTS.onReady();
  }

  function setNav(open){
    el('shell').classList.toggle('nav-open', open);
    document.querySelector('.ops-burger').setAttribute('aria-expanded', open ? 'true' : 'false');
    var f = open ? document.querySelector('.ops-nav-x') : document.querySelector('.ops-burger');
    if(f) f.focus();
  }
  /* the handlers the shell markup calls */
  global.ADM = {
    refresh: function(){ refresh(); },
    toggleLang: function(){
      var r = root(), en = r.lang === 'en';
      r.lang = en ? 'ar' : 'en'; r.dir = en ? 'rtl' : 'ltr';
      try { localStorage.setItem('raf_lang', r.lang); } catch(e){}
      applyLang(); refresh(); el('langBtn').focus();
    },
    /* a per-viewer preference, saved only on this explicit action */
    toggleTheme: function(){
      var next = theme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('raf_admin_theme', next); } catch(e){}
      renderThemeBtn(); el('themeBtn').focus();
    },
    openNav: function(){ setNav(true); },
    closeNav: function(){ setNav(false); }
  };
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && el('shell') && el('shell').classList.contains('nav-open')) setNav(false);
  });

  function start(opts){
    OPTS = opts || {};
    if(!OPTS.canEnter) OPTS.canEnter = function(){ return destinations().length > 0; };
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  global.RAFAdmin = {
    start:start, refresh:refresh,
    me:function(){ return ME ? { id:ME.id, name:ME.name, roleId:ME.roleId } : null; },
    can:can, caps:function(){ return CAP; }, logisticsOps:logisticsOps, driversView:driversView, csView:csView,
    destinations:destinations, requestsView:requestsView, storesView:storesView,
    T:T, L:L, esc:esc, clockOf:clockOf, isoOf:isoOf, isEn:isEn, el:el,
    NEWTAB:NEWTAB, srNew:srNew, ext:ext
  };
})(window);
