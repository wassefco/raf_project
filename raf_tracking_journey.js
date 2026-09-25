/* ============================================================================
 * RAF Marketplace — DELIVERY JOURNEY CARD  (RAFJourneyUI · presentation only)
 * ----------------------------------------------------------------------------
 * The customer's order-tracking card: store → driver → customer, drawn as a
 * journey along a curved route with the three milestones on it.
 *
 * IT DECIDES NOTHING. The tracking page projects the existing authoritative
 * data (order, snapshot, RAFOrderEngine milestones, RAFSource, RAFDriverCommunication)
 * into a plain model and hands it here; this module only draws it:
 *
 *   RAFJourneyUI.html(model) → string        RAFJourneyUI.settle(rootEl)
 *
 *   model = { orderId, stage:0|1|2, cancelled,
 *             store:{ name, category, logo, initial },
 *             status:{ label, message },
 *             acceptedAt|null, deliveredAt|null        (ms from the audited milestones — never guessed),
 *             driver:{ name, rating:{ average, count }|null }|null,
 *             canMessage, canCall, callNote|null,
 *             compensation:<RAFCompensation customer view>|null, compNote|null,
 *             rating:{ state:'available'|'rated' }|null }
 *
 * THE ROUTE IS NOT A MAP. RAF has no location data: the rider stands at the
 * milestone the order has actually reached and never between two of them, so
 * nothing on this card suggests a live position.
 *
 * DIRECTION — the journey follows the reading direction: store → driver →
 * customer runs right-to-left in Arabic and left-to-right in English.
 *
 * MOTION — route flow, current-milestone pulse, rider movement and the
 * delivered completion are CSS only, and all of it stops under
 * prefers-reduced-motion. Script: settle() lets the progress transition from
 * the last stage this page showed to the current one, and ticks the delivery
 * timer once a second while the order is still being delivered.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFJourneyUI) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  /* ---------------------------------------------------------------- styles */
  var CSS = [
    '.jr{--jr-green:var(--green,#2E9E5B);--jr-green-d:#1F7A45;--jr-gold:var(--gold,#C9A84C);--jr-gold-d:var(--gold2,#A07828);',
    '  --jr-ink:var(--ink,#15130F);--jr-mute:var(--text3,#8A857C);--jr-line:var(--border,#E2DBCC);--jr-cream:#FBF8F2;',
    '  position:relative;background:linear-gradient(180deg,#FFFFFF 0%,var(--jr-cream) 100%);border:1px solid var(--jr-line);',
    '  border-radius:28px;box-shadow:0 1px 2px rgba(20,16,8,.04),0 24px 48px -28px rgba(20,16,8,.28);margin-bottom:16px;overflow:hidden;}',
    /* header */
    '.jr-h{display:flex;align-items:flex-start;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;padding:26px 28px 6px;}',
    '.jr-id{display:flex;align-items:center;gap:14px;min-width:0;}',
    '.jr-logo{width:58px;height:58px;flex:0 0 auto;border-radius:16px;background:#F1EADB center/cover no-repeat;border:1px solid var(--jr-line);',
    '  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;color:var(--jr-gold-d);overflow:hidden;box-shadow:0 6px 14px -8px rgba(20,16,8,.35);}',
    '.jr-logo img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.jr-store{min-width:0;}',
    '.jr-store b{display:block;font-size:19px;font-weight:800;color:var(--jr-ink);line-height:1.35;overflow-wrap:anywhere;}',
    '.jr-store span{display:block;font-size:13px;color:var(--jr-mute);margin-top:2px;}',
    '.jr-sep{width:1px;align-self:stretch;background:var(--jr-line);margin:4px 4px;}',
    '.jr-no span{display:block;font-size:13px;color:var(--jr-mute);}',
    '.jr-no b{display:block;font-family:var(--fen,"DM Sans",sans-serif);font-size:18px;font-weight:800;color:var(--jr-ink);letter-spacing:.2px;margin-top:2px;}',
    '.jr-st{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0;}',
    '.jr-badge{display:inline-flex;align-items:center;gap:10px;min-height:40px;padding:0 20px;border-radius:999px;font-size:16px;font-weight:800;',
    '  background:rgba(46,158,91,.10);border:1px solid rgba(46,158,91,.28);color:var(--jr-green-d);}',
    '.jr-badge i{width:9px;height:9px;border-radius:50%;background:currentColor;flex:0 0 auto;}',
    '.jr[data-stage="0"] .jr-badge{background:var(--gold-soft,rgba(201,168,76,.12));border-color:rgba(201,168,76,.4);color:var(--jr-gold-d);}',
    '.jr.is-cancelled .jr-badge{background:rgba(217,83,79,.10);border-color:rgba(217,83,79,.3);color:#B03A36;}',
    '.jr-msg{font-size:14px;color:var(--text2,#5A5650);line-height:1.6;display:flex;align-items:center;gap:6px;}',
    '.jr-msg .ti{color:var(--jr-gold-d);font-size:17px;}',
    /* the journey — physical left-to-right in both languages */
    '.jr-j{position:relative;padding:6px 20px 0;}',
    '.jr-sky{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.9;}',
    '.jr-sc{position:relative;display:grid;grid-template-columns:repeat(3,1fr);align-items:end;height:180px;}',
    '.jr-art{position:relative;display:flex;justify-content:center;align-items:flex-end;height:100%;transition:filter .6s,opacity .6s;}',
    '.jr-art svg{width:min(100%,250px);height:auto;display:block;overflow:visible;}',
    '.jr-art.up{filter:grayscale(.85) saturate(.6);opacity:.5;}',
    /* rendered scene cutouts (transparent): each stands on the route, the
       rider in front, and the three read as one continuous street */
    '.jr-raster .jr-sc{height:auto;min-height:0;padding-top:8px;}',
    '.jr-raster .jr-art{align-items:flex-end;}',
    '.jr-raster .jr-art:nth-child(2){justify-content:flex-start;}.jr-raster .jr-art:nth-child(4){justify-content:flex-end;}',
    '.jr-raster .jr-art:nth-child(3){z-index:2;}',
    '.jr-img{display:block;width:100%;max-width:300px;height:auto;user-select:none;pointer-events:none;',
    '  filter:drop-shadow(0 10px 12px rgba(60,40,10,.10));}',
    '.jr-img-ride{width:86%;margin-bottom:-6px;}',
    '.jr-raster .jr-road{margin-top:-26px;}',
    '.jr-raster .jr-sky{opacity:.55;}',
    /* Arabic: the journey itself runs right → left — the columns follow the
       page direction, and the route (and the green progress on it) is drawn
       mirrored. The artwork is placed, never flipped, so its lettering reads. */
    '.jr-rtl .jr-road > svg,.jr-rtl .jr-prog{transform:scaleX(-1);}',
    '.jr-art.cur .jr-img-ride{animation:jrRide 1.6s ease-in-out infinite;}',
    '.jr-rtl .jr-art.cur .jr-img-ride{animation-name:jrRideRtl;}',
    '@keyframes jrRideRtl{0%,100%{transform:translate(0,0);}50%{transform:translate(-3px,-2px);}}',
    '.jr-art.done-last .jr-img-home{animation:jrArrive 1.2s ease-out 1 both;}',
    '@keyframes jrArrive{from{opacity:.55;transform:scale(.97);}to{opacity:1;transform:none;}}',
    '.jr-road{position:relative;height:74px;margin-top:-18px;}',
    '.jr-road > svg,.jr-prog > svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}',
    '.jr-node svg{display:block;flex:0 0 auto;}',
    '.jr-prog{position:absolute;inset:0;clip-path:inset(0 calc(100% - var(--jr-p,0%)) 0 0);transition:clip-path var(--jr-dur,1400ms) cubic-bezier(.4,0,.2,1);}',
    '.jr-flow{stroke-dasharray:14 12;animation:jrFlow 1.1s linear infinite;}',
    '.jr[data-stage="2"] .jr-flow,.jr.is-cancelled .jr-flow,.jr[data-stage="0"] .jr-flow{animation:none;}',
    '@keyframes jrFlow{to{stroke-dashoffset:-26;}}',
    /* milestones on the route */
    '.jr-node{position:absolute;top:var(--y);inset-inline-start:var(--x);width:46px;height:46px;margin-block-start:-23px;margin-inline-start:-23px;border-radius:50%;',
    '  background:#fff;border:3px solid #D9D2C3;display:flex;align-items:center;justify-content:center;color:#B9B1A1;font-size:22px;',
    '  box-shadow:0 6px 16px -8px rgba(20,16,8,.4);transition:background .5s,border-color .5s,color .5s,transform .5s;}',
    '.jr-node.done{background:linear-gradient(180deg,#2FA15C,#1F8A4C);border-color:#fff;color:#fff;box-shadow:0 0 0 1px rgba(31,138,76,.35),0 8px 18px -8px rgba(31,122,69,.55);}',
    '.jr-node.cur{background:#fff;border-color:var(--jr-green);color:var(--jr-green);transform:scale(1.08);}',
    '.jr-node.cur::before,.jr-node.final::before{content:"";position:absolute;inset:-10px;border-radius:50%;border:2px solid rgba(46,158,91,.35);}',
    '.jr-node.cur::before{animation:jrPulse 2s ease-out infinite;}',
    '.jr-node.final{width:56px;height:56px;margin-block-start:-28px;margin-inline-start:-28px;background:var(--jr-green);border:4px solid #fff;color:#fff;font-size:26px;',
    '  background:linear-gradient(180deg,#2FA15C,#1F8A4C);box-shadow:0 0 0 3px #1F8A4C,0 0 0 11px rgba(46,158,91,.14),0 12px 26px -8px rgba(31,122,69,.6);}',
    '.jr-node.final::before{inset:-14px;border-color:rgba(46,158,91,.25);animation:jrDone 1.2s ease-out 1 both;}',
    '.jr.is-cancelled .jr-node{background:#fff;border-color:#DDD6C8;color:#C4BCAC;transform:none;}',
    '.jr.is-cancelled .jr-node::before{display:none;}',
    '.jr-node svg{width:22px;height:22px;}',
    '.jr-node .ck path{stroke-dasharray:24;stroke-dashoffset:0;}',
    '.jr-node.final .ck path{animation:jrCheck .6s ease-out .3s 1 both;}',
    '@keyframes jrPulse{0%{transform:scale(.85);opacity:1;}100%{transform:scale(1.45);opacity:0;}}',
    '@keyframes jrDone{0%{transform:scale(.6);opacity:0;}60%{opacity:1;}100%{transform:scale(1);opacity:1;}}',
    '@keyframes jrCheck{from{stroke-dashoffset:24;}to{stroke-dashoffset:0;}}',
    '.jr-note{margin:6px 0 16px;text-align:center;font-size:12.5px;color:var(--jr-mute);}',
    '.jr-j{padding-bottom:10px;}',
    /* below the journey */
    '.jr-f{display:flex;flex-direction:column;gap:16px;padding:22px 28px 26px;border-top:1px solid rgba(226,219,204,.8);background:rgba(255,255,255,.6);}',
    /* below the tracking line: the ETA, then (only once it has begun) the compensation line */
    '.jr-mid{display:flex;flex-direction:column;gap:12px;padding:0 28px 18px;}',
    '.jr-eta{display:flex;align-items:center;gap:12px;min-height:58px;padding:9px 14px;border-radius:16px;background:#fff;border:1px solid var(--jr-line);}',
    '.jr-eta .ic{width:38px;height:38px;flex:0 0 auto;border-radius:12px;background:#F4F1EA;color:var(--jr-gold-d);display:flex;align-items:center;justify-content:center;font-size:19px;}',
    '.jr-eta-b{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;line-height:1.35;}',
    '.jr-eta-b span{font-size:12px;color:var(--jr-mute);}',
    '.jr-eta-b b{font-size:16px;font-weight:800;color:var(--jr-ink);min-width:7.5ch;font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.jr-eta small{flex:0 1 auto;font-size:11.5px;color:var(--jr-mute);text-align:end;max-width:52%;}',
    '.jr-cl{padding:14px 16px 16px;border-radius:18px;background:linear-gradient(120deg,#FFFBEF 0%,#FFF6DF 100%);border:1px solid rgba(201,168,76,.45);}',
    '.jr-cl.done{background:#F6FAF7;border-color:rgba(46,158,91,.3);}',
    '.jr-cl-h{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:800;color:var(--jr-ink);}',
    '.jr-cl-h .ti{font-size:19px;color:var(--jr-gold-d);}.jr-cl.done .jr-cl-h .ti{color:var(--jr-green-d);}',
    '.jr-cl-m{margin:4px 0 12px;font-size:12.5px;line-height:1.7;color:var(--text2,#5A5650);}',
    '.jr-cl-t{position:relative;height:10px;border-radius:999px;background:#EDE6D4;margin:4px 10px 30px;}',
    '.jr-cl-f{position:absolute;inset-block:0;inset-inline-start:0;border-radius:inherit;background:linear-gradient(90deg,#D9B85C,var(--jr-gold));max-width:100%;}',
    '.jr-cl.done .jr-cl-f{background:var(--jr-green);}',
    '.jr-cl-k{position:absolute;top:50%;inset-inline-start:var(--at);width:22px;height:22px;margin-top:-11px;margin-inline-start:-11px;border-radius:50%;background:#fff;',
    '  border:2px solid #D9CFB6;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--jr-mute);}',
    '.jr-cl-k.on{border-color:var(--jr-gold-d);background:var(--jr-gold);color:#1C1606;}.jr-cl.done .jr-cl-k.on{border-color:var(--jr-green-d);background:var(--jr-green);color:#fff;}',
    '.jr-cl-k em{position:absolute;top:24px;font-style:normal;font-size:11px;font-weight:700;color:var(--jr-mute);white-space:nowrap;}',
    '.jr-cl-s{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--jr-mute);}',
    '.jr-cl-s b{color:var(--jr-ink);font-variant-numeric:tabular-nums;}',
    '.jr-info{display:flex;align-items:center;gap:16px 24px;flex-wrap:wrap;}',
    '.jr-acts{display:flex;gap:12px;flex-wrap:wrap;margin-inline-start:auto;}',
    '.jr .jr-btn{min-height:52px;min-width:150px;padding:0 22px;border-radius:16px;border:1px solid var(--jr-line);background:#F4F1EA;color:var(--jr-ink);',
    '  font-family:inherit;font-size:16px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;',
    '  transition:background .2s,border-color .2s,transform .15s,box-shadow .2s;}',
    '.jr .jr-btn .ti{font-size:22px;color:var(--text2,#5A5650);}',
    '.jr .jr-btn:hover{background:#fff;border-color:var(--jr-gold);box-shadow:0 8px 18px -12px rgba(160,120,40,.55);}',
    '.jr .jr-btn:active{transform:translateY(1px) scale(.99);}',
    '.jr .jr-btn:focus-visible{outline:2px solid var(--jr-gold);outline-offset:3px;}',
    '.jr .jr-btn:disabled{opacity:.55;cursor:not-allowed;}',
    '.jr-drv{display:flex;align-items:center;gap:14px 18px;min-width:0;flex:1 1 320px;flex-wrap:wrap;}',
    '.jr-drv > div{min-width:0;}',
    '.jr-stars{display:inline-flex;align-items:center;gap:5px;margin-top:4px;font-size:14px;font-weight:800;color:var(--jr-ink);}',
    '.jr-stars .ti{color:#E0A526;font-size:17px;}.jr-stars em{font-style:normal;font-weight:600;color:var(--jr-mute);font-size:12.5px;}',
    '.jr-stars.none{font-weight:600;color:var(--jr-mute);font-size:12.5px;}',
    /* the digital delivery timer */
    /* a compact badge of FIXED width: the digits are monospaced and the box never
       resizes, so the driver beside it never moves while the clock ticks */
    '.jr-timer{display:flex;align-items:center;gap:10px;flex:0 0 auto;width:248px;max-width:100%;padding:10px 12px;border-radius:16px;',
    '  background:#fff;border:1px solid var(--jr-line);box-shadow:0 6px 16px -12px rgba(20,16,8,.35);}',
    '.jr-timer > div{flex:1 1 auto;min-width:0;}',
    '.jr-timer .ic{width:38px;height:38px;flex:0 0 auto;border-radius:50%;border:2px solid var(--jr-gold);color:var(--jr-gold-d);display:flex;align-items:center;justify-content:center;font-size:19px;background:#fff;}',
    '.jr-timer.on .ic{border-color:var(--jr-green);color:var(--jr-green-d);}',
    '.jr-timer > div > span{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--jr-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.jr-live{width:8px;height:8px;border-radius:50%;background:var(--jr-green);animation:jrBlink 1.6s ease-in-out infinite;}',
    '@keyframes jrBlink{0%,100%{opacity:1;}50%{opacity:.25;}}',
    '.jr-clock{display:block;width:8.4ch;font-family:ui-monospace,"SF Mono","Cascadia Mono","Roboto Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;',
    '  font-size:21px;font-weight:700;letter-spacing:.5px;color:var(--jr-ink);line-height:1.2;margin-top:1px;white-space:nowrap;}',
    /* a finished delivery reads as a calm, static duration — not a running clock */
    '.jr-clock.done{width:auto;font-family:inherit;font-size:18px;font-weight:800;letter-spacing:0;}',
    '.jr-timer small{display:block;font-size:11px;line-height:1.45;color:var(--jr-mute);margin-top:1px;}',
    /* icon-only Call / Message */
    '.jr .jr-ic{width:48px;height:48px;min-width:48px;padding:0;border-radius:50%;border:1px solid var(--jr-line);background:#F4F1EA;color:var(--jr-ink);',
    '  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .2s,border-color .2s,transform .15s;}',
    '.jr .jr-ic .ti{font-size:22px;color:var(--jr-green-d);}',
    '.jr .jr-ic:hover{background:#fff;border-color:var(--jr-gold);}',
    '.jr .jr-ic:active{transform:scale(.96);}',
    '.jr .jr-ic:focus-visible{outline:2px solid var(--jr-gold);outline-offset:3px;}',
    '.jr .jr-ic:disabled{opacity:.55;cursor:not-allowed;}',
    '.jr-drv .jr-acts{gap:10px;}',
    '.jr .jr-ic{position:relative;}',
    '.jr-unread{position:absolute;top:-5px;inset-inline-end:-5px;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:#C8412D;color:#fff;',
    '  font-family:var(--fen,"DM Sans",sans-serif);font-size:12px;font-weight:800;line-height:22px;text-align:center;box-shadow:0 0 0 2px #fff;font-variant-numeric:tabular-nums;}',
    /* the driver is at the door: the delivery verification code */
    '.jr-code{display:flex;align-items:center;gap:14px 18px;flex-wrap:wrap;padding:16px 18px;border-radius:20px;',
    '  background:linear-gradient(120deg,#EEF7F0 0%,#F7FBF8 100%);border:1px solid rgba(46,158,91,.35);box-shadow:0 14px 30px -24px rgba(31,122,69,.55);}',
    '.jr-code-ic{width:48px;height:48px;flex:0 0 auto;border-radius:14px;background:var(--jr-green);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;}',
    '.jr-code-b{flex:1 1 220px;min-width:0;}',
    '.jr-code-b b{display:block;font-size:15px;font-weight:800;color:var(--jr-ink);}',
    '.jr-code-b p{margin:3px 0 0;font-size:13px;line-height:1.7;color:var(--text2,#5A5650);}',
    '.jr-code-n{flex:0 0 auto;min-width:112px;padding:6px 18px;border-radius:16px;background:#fff;border:2px dashed var(--jr-green);text-align:center;',
    '  font-family:ui-monospace,"SF Mono","Cascadia Mono","Roboto Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:40px;font-weight:800;letter-spacing:8px;color:var(--jr-green-d);line-height:1.2;}',
    /* the way to rate a delivered order */
    '.jr .jr-rate{margin-inline-start:auto;background:linear-gradient(180deg,#D9B85C,var(--jr-gold));border-color:var(--jr-gold-d);color:#1C1606;text-decoration:none;}',
    '.jr .jr-rate .ti{color:#1C1606;}',
    '.jr-rated{margin-inline-start:auto;display:inline-flex;align-items:center;gap:8px;color:var(--jr-green-d);font-weight:700;font-size:14.5px;}',
    '.jr-rated .ti{font-size:22px;}',
    /* compensation — a real coupon, drawn as a ticket */
    '.jr-comp{position:relative;display:flex;align-items:center;gap:16px 18px;padding:16px 18px;border-radius:20px;',
    '  background:linear-gradient(120deg,#FFFBEF 0%,#FFF6DF 55%,#EEF7F0 100%);border:1px solid rgba(201,168,76,.45);',
    '  box-shadow:0 14px 30px -22px rgba(160,120,40,.55);}',
    '.jr-comp::before,.jr-comp::after{content:"";position:absolute;inset-inline-start:84px;width:18px;height:18px;border-radius:50%;background:#FBF8F2;border:1px solid rgba(201,168,76,.45);}',
    '.jr-comp::before{top:-10px;}.jr-comp::after{bottom:-10px;}',
    '.jr-comp-stub{width:64px;height:64px;flex:0 0 auto;border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:32px;color:#fff;',
    '  background:linear-gradient(145deg,#E2BE5E,#B98A2C);box-shadow:0 10px 20px -10px rgba(160,120,40,.8);}',
    '.jr-comp-b{flex:1 1 240px;min-width:0;padding-inline-start:12px;border-inline-start:2px dashed rgba(201,168,76,.5);}',
    '.jr-comp-k{display:block;font-size:13px;font-weight:700;color:var(--jr-gold-d);}',
    '.jr-comp-amt{display:block;font-size:28px;font-weight:800;color:var(--jr-green-d);line-height:1.2;margin-top:2px;}',
    '.jr-comp-msg{margin:6px 0 0;font-size:13px;line-height:1.7;color:var(--text2,#5A5650);}',
    '.jr-comp-meta{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px;font-size:12.5px;color:var(--jr-mute);align-items:center;}',
    '.jr-comp-st{display:inline-flex;align-items:center;min-height:26px;padding:0 10px;border-radius:999px;background:#fff;border:1px solid var(--jr-line);font-weight:700;color:var(--jr-ink);}',
    '.jr-comp-st.s-in_wallet,.jr-comp-st.s-consumed{background:rgba(46,158,91,.1);border-color:rgba(46,158,91,.3);color:var(--jr-green-d);}',
    '.jr-comp-st.s-expired,.jr-comp-st.s-voided,.jr-comp-st.s-reversed{color:#8A857C;}',
    '.jr .jr-comp-cta{background:var(--jr-green);border-color:var(--jr-green-d);color:#fff;}.jr .jr-comp-cta .ti{color:#fff;}',
    '.jr .jr-comp-cta:hover{background:var(--jr-green-d);color:#fff;}',
    '.jr-av{width:60px;height:60px;flex:0 0 auto;border-radius:50%;background:radial-gradient(circle at 35% 30%,#F4E3B5,#D9B25A);',
    '  color:#4A3712;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;border:3px solid #fff;box-shadow:0 6px 16px -8px rgba(20,16,8,.45);}',
    '.jr-drv > div > span{display:block;font-size:13px;color:var(--jr-mute);}',
    '.jr-drv > div > b{display:block;font-size:18px;font-weight:800;color:var(--jr-ink);margin-top:2px;overflow-wrap:anywhere;}',
    '.jr-vr{width:1px;align-self:stretch;background:var(--jr-line);}',
    '.jr-callnote{flex-basis:100%;font-size:12.5px;color:#A63A36;}',
    /* illustration motion */
    '.jr-art.cur .rider{animation:jrRide 1.6s ease-in-out infinite;}',
    '.jr-art.cur .wheel{animation:jrSpin .7s linear infinite;transform-box:fill-box;transform-origin:center;}',
    '.jr-art.cur .speed line{animation:jrSpeed 1s ease-in-out infinite;}',
    '.jr-art.cur .speed line:nth-child(2){animation-delay:.2s;}.jr-art.cur .speed line:nth-child(3){animation-delay:.4s;}',
    '.jr-art.cur .glow{animation:jrGlow 2.4s ease-in-out infinite;}',
    '.jr-art.done-last .bag{animation:jrHand 1.4s ease-out 1 both;}',
    '.jr-sky .cloud{animation:jrCloud 14s ease-in-out infinite alternate;}',
    '@keyframes jrRide{0%,100%{transform:translate(0,0);}50%{transform:translate(3px,-2px);}}',
    '@keyframes jrSpin{to{transform:rotate(360deg);}}',
    '@keyframes jrSpeed{0%,100%{opacity:.25;transform:translateX(0);}50%{opacity:.9;transform:translateX(-6px);}}',
    '@keyframes jrGlow{0%,100%{opacity:.75;}50%{opacity:1;}}',
    '@keyframes jrHand{0%{transform:translateX(-10px);opacity:.4;}100%{transform:none;opacity:1;}}',
    '@keyframes jrCloud{to{transform:translateX(18px);}}',
    '@media (prefers-reduced-motion:reduce){.jr *,.jr *::before{animation:none !important;transition:none !important;}}',
    /* tablet */
    '@media (max-width:760px){.jr-h{padding:20px 18px 4px;}.jr-sc{height:150px;}.jr-f{padding:18px;}.jr-mid{padding:0 18px 16px;}}',
    /* phone: same journey, re-proportioned; the timer and the driver stack */
    '@media (max-width:560px){.jr{border-radius:22px;}.jr-h{flex-direction:column;gap:12px;}.jr-sep{display:none;}',
    '  .jr-idrow{width:100%;justify-content:space-between;}.jr-logo{width:48px;height:48px;border-radius:14px;}',
    '  .jr-store b{font-size:16px;}.jr-no b{font-size:15px;}.jr-badge{font-size:14px;min-height:36px;padding:0 14px;}',
    '  .jr-j{padding:6px 12px 0;}.jr-sc{height:108px;}',
    /* phone: each scene keeps its OWN column at a controlled height (whole image,
       aspect kept, nothing cropped), and the road runs BELOW the art in normal
       flow — no widened, overlapping scenes and no negative pull-up */
    '  .jr-raster .jr-sc{height:clamp(78px,26vw,112px);min-height:0;padding-top:6px;column-gap:4px;}',
    '  .jr-raster .jr-art{height:100%;min-width:0;justify-content:center !important;}',
    '  .jr-raster .jr-img{width:auto;height:auto;max-width:100%;max-height:100%;}',
    '  .jr-raster .jr-img-ride{max-height:94%;margin-bottom:0;}',
    '  .jr-road{height:46px;margin-top:2px;}.jr-raster .jr-road{margin-top:2px;}',
    '  .jr-node{width:32px;height:32px;margin-block-start:-16px;margin-inline-start:-16px;font-size:16px;border-width:2.5px;}.jr-node svg{width:16px;height:16px;}',
    '  .jr-node.final{width:38px;height:38px;margin-block-start:-19px;margin-inline-start:-19px;}',
    '  .jr-node.cur::before,.jr-node.final::before{inset:-6px;}',
    '  .jr-msg{display:block;}.jr-msg .ti{display:inline-block;vertical-align:-2px;margin-inline-start:4px;}',
    '  .jr-f{padding:16px;}.jr-info{flex-direction:column;align-items:stretch;gap:16px;}.jr-drv{flex:0 0 auto;}.jr-vr{display:none;}',
    '  .jr-acts{flex-basis:100%;margin-inline-start:0;}.jr .jr-btn{flex:1 1 0;min-width:0;}.jr-drv .jr-acts{flex-basis:auto;margin-inline-start:auto;}.jr .jr-rate,.jr-rated{margin-inline-start:0;}',
    '  .jr-comp{flex-wrap:wrap;padding:14px;}.jr-comp::before,.jr-comp::after{display:none;}.jr-comp-stub{width:52px;height:52px;font-size:26px;}',
    '  .jr-comp-b{padding-inline-start:0;border-inline-start:0;}.jr-comp-amt{font-size:24px;}.jr .jr-comp-cta{flex:1 1 100%;}.jr-timer{width:100%;}.jr-code-n{flex:1 1 100%;}.jr-mid{padding:0 16px 14px;}.jr-eta{flex-wrap:wrap;}.jr-eta small{max-width:none;flex-basis:100%;text-align:start;}}'
  ].join('\n');
  function injectCss(){
    if (document.getElementById('jrCss')) return;
    var s = document.createElement('style'); s.id = 'jrCss'; s.textContent = CSS; document.head.appendChild(s);
  }

  /* ---------------------------------------------------------- illustrations
     Hand-drawn inline SVG (no external dependency, no image asset). */
  var ART = {
    store:
      '<svg viewBox="0 0 250 170" aria-hidden="true" focusable="false">'
      + '<ellipse cx="125" cy="163" rx="112" ry="7" fill="#E9E0CC"/>'
      /* trees */
      + '<rect x="20" y="118" width="5" height="44" rx="2" fill="#7A5A3A"/><circle cx="22" cy="112" r="17" fill="#4F9A57"/><circle cx="12" cy="124" r="11" fill="#3E8A48"/><circle cx="33" cy="122" r="11" fill="#5DAE63"/>'
      + '<rect x="224" y="112" width="5" height="50" rx="2" fill="#7A5A3A"/><circle cx="226" cy="104" r="19" fill="#4F9A57"/><circle cx="237" cy="118" r="12" fill="#3E8A48"/><circle cx="214" cy="118" r="11" fill="#5DAE63"/>'
      /* building */
      + '<rect x="52" y="44" width="146" height="118" rx="4" fill="#F4E8D2"/><rect x="52" y="44" width="146" height="118" rx="4" fill="none" stroke="#E2D2B2"/>'
      + '<rect x="46" y="26" width="158" height="26" rx="5" fill="#3A2E24"/><rect x="46" y="22" width="158" height="7" rx="3" fill="#2B221B"/>'
      + '<g transform="translate(116 30)"><rect x="0" y="4" width="18" height="13" rx="2.5" fill="none" stroke="#D9B25A" stroke-width="2.2"/><path d="M5 4 v-2 a4 4 0 0 1 8 0 v2" fill="none" stroke="#D9B25A" stroke-width="2.2"/></g>'
      /* awning */
      + '<path d="M46 52 h158 l-4 22 h-150 z" fill="#FFF6E3"/>'
      + '<path d="M50 52h14l-2 22h-12zM78 52h14l-1 22h-13zM106 52h14v22h-14zM134 52h14l1 22h-14zM162 52h14l2 22h-14zM190 52h14l-4 22h-11z" fill="#D9B25A"/>'
      + '<path d="M50 74 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 q7 7 14 0 z" fill="#C99A3E"/>'
      /* windows with warm light */
      + '<g class="glow"><rect x="62" y="88" width="44" height="46" rx="4" fill="#FFE2A0"/><rect x="146" y="88" width="44" height="46" rx="4" fill="#FFE2A0"/></g>'
      + '<rect x="62" y="88" width="44" height="46" rx="4" fill="none" stroke="#6B4F36" stroke-width="3"/><path d="M84 88v46M62 111h44" stroke="#6B4F36" stroke-width="2"/>'
      + '<rect x="146" y="88" width="44" height="46" rx="4" fill="none" stroke="#6B4F36" stroke-width="3"/><path d="M168 88v46M146 111h44" stroke="#6B4F36" stroke-width="2"/>'
      + '<rect x="70" y="120" width="10" height="8" rx="2" fill="#C98E4A" opacity=".7"/><rect x="154" y="118" width="12" height="10" rx="2" fill="#B7784A" opacity=".7"/>'
      /* door */
      + '<rect x="112" y="92" width="28" height="70" rx="3" fill="#7A5638"/><rect x="116" y="97" width="20" height="30" rx="2" fill="#FFE2A0" opacity=".85"/><circle cx="134" cy="132" r="2" fill="#D9B25A"/>'
      /* planters */
      + '<rect x="56" y="146" width="20" height="14" rx="3" fill="#8B6A48"/><circle cx="60" cy="142" r="7" fill="#5DAE63"/><circle cx="71" cy="140" r="8" fill="#4F9A57"/>'
      + '<rect x="176" y="146" width="20" height="14" rx="3" fill="#8B6A48"/><circle cx="181" cy="141" r="8" fill="#4F9A57"/><circle cx="191" cy="143" r="7" fill="#5DAE63"/>'
      + '</svg>',

    ride:
      '<svg viewBox="0 0 250 170" aria-hidden="true" focusable="false">'
      + '<ellipse cx="128" cy="163" rx="86" ry="6" fill="#E9E0CC"/>'
      + '<g class="speed" stroke="#D8CDB6" stroke-width="4" stroke-linecap="round"><line x1="14" y1="96" x2="56" y2="96"/><line x1="4" y1="112" x2="50" y2="112"/><line x1="20" y1="128" x2="54" y2="128"/></g>'
      + '<g class="rider">'
      /* wheels */
      + '<g class="wheel"><circle cx="78" cy="144" r="18" fill="#26211C"/><circle cx="78" cy="144" r="8" fill="#9E9587"/><path d="M78 128v32M62 144h32" stroke="#4A433A" stroke-width="2"/></g>'
      + '<g class="wheel"><circle cx="190" cy="144" r="18" fill="#26211C"/><circle cx="190" cy="144" r="8" fill="#9E9587"/><path d="M190 128v32M174 144h32" stroke="#4A433A" stroke-width="2"/></g>'
      /* delivery box */
      + '<rect x="48" y="62" width="52" height="46" rx="6" fill="#1F1B17"/><rect x="48" y="62" width="52" height="8" rx="4" fill="#2E2822"/>'
      + '<text x="74" y="97" text-anchor="middle" font-family="Tajawal,sans-serif" font-size="22" font-weight="800" fill="#D9B25A">رف</text>'
      /* scooter body */
      + '<path d="M58 132 q2 -24 30 -24 h58 q14 0 18 14 l6 20 h-112 z" fill="#D4A83C"/>'
      + '<path d="M62 128 q4 -12 22 -12 h40" fill="none" stroke="#B8892B" stroke-width="3"/>'
      + '<rect x="84" y="100" width="54" height="11" rx="5" fill="#2A241E"/>'
      + '<path d="M164 142 l14 -58 h10 l-12 58 z" fill="#C79A33"/><path d="M168 138 q14 -4 26 6 l-4 4 q-10 -8 -20 -4z" fill="#D4A83C"/>'
      + '<path d="M176 84 l12 -12 M184 72 h12" stroke="#2A241E" stroke-width="5" stroke-linecap="round"/><circle cx="197" cy="86" r="5" fill="#FFF3C8"/>'
      /* rider */
      + '<path d="M104 102 l18 26 h24 l-4 -8 h-16 l-10 -22z" fill="#2B2520"/>'
      + '<path d="M96 60 q10 -12 26 -8 l14 30 q-4 18 -22 22 l-18 -2z" fill="#1F1B17"/>'
      + '<path d="M118 62 l30 14 l-4 8 l-28 -10z" fill="#C79A33"/><path d="M146 76 l28 4" stroke="#1F1B17" stroke-width="7" stroke-linecap="round"/>'
      + '<circle cx="176" cy="80" r="5" fill="#E0B08A"/>'
      + '<circle cx="118" cy="40" r="14" fill="#E0B08A"/><path d="M106 44 q12 12 24 0 v6 q-12 10 -24 0z" fill="#4A3524"/>'
      + '<path d="M100 38 a18 18 0 0 1 36 -4 l2 8 h-12 q-4 -6 -12 -6 h-14z" fill="#D4A83C"/><path d="M126 36 h12 q2 6 -2 8 h-10z" fill="#2A241E"/>'
      + '<path d="M104 30 q10 -10 26 -4" fill="none" stroke="#F1D27A" stroke-width="3" stroke-linecap="round"/>'
      + '</g></svg>',

    home:
      '<svg viewBox="0 0 250 170" aria-hidden="true" focusable="false">'
      + '<ellipse cx="125" cy="163" rx="112" ry="7" fill="#E9E0CC"/>'
      /* house */
      + '<rect x="120" y="30" width="126" height="132" rx="4" fill="#F1E6D6"/><rect x="112" y="22" width="138" height="12" rx="4" fill="#E2D2BA"/>'
      + '<rect x="176" y="62" width="44" height="100" rx="3" fill="#8A5A34"/><rect x="182" y="70" width="14" height="38" rx="2" fill="#7A4E2C"/><rect x="200" y="70" width="14" height="38" rx="2" fill="#7A4E2C"/>'
      + '<rect x="182" y="114" width="32" height="40" rx="2" fill="#7A4E2C"/><circle cx="212" cy="112" r="2.4" fill="#D9B25A"/>'
      + '<rect x="228" y="80" width="6" height="12" rx="2" fill="#3A2E24"/><circle cx="231" cy="94" r="4" fill="#FFE2A0" class="glow"/>'
      + '<rect x="126" y="136" width="18" height="24" rx="3" fill="#8B6A48"/><path d="M135 136 q-12 -18 -4 -34 q8 14 4 34z M135 136 q12 -20 4 -36 q-8 14 -4 36z" fill="#4F9A57"/>'
      /* tree */
      + '<rect x="16" y="120" width="5" height="42" rx="2" fill="#7A5A3A"/><circle cx="18" cy="112" r="16" fill="#4F9A57"/><circle cx="9" cy="124" r="10" fill="#3E8A48"/><circle cx="29" cy="123" r="10" fill="#5DAE63"/>'
      /* driver, handing over */
      + '<rect x="60" y="120" width="12" height="42" rx="4" fill="#2B2520"/><rect x="74" y="120" width="12" height="42" rx="4" fill="#2B2520"/>'
      + '<path d="M56 86 q16 -12 34 0 l4 38 h-40z" fill="#1F1B17"/><path d="M58 90 l-4 34 h8 l2 -32z M88 90 l4 30 h-6 l-2 -28z" fill="#C79A33"/>'
      + '<path d="M86 96 q18 4 30 10" stroke="#1F1B17" stroke-width="9" stroke-linecap="round" fill="none"/>'
      + '<circle cx="72" cy="66" r="13" fill="#E0B08A"/><path d="M61 70 q11 11 22 0 v5 q-11 9 -22 0z" fill="#4A3524"/>'
      + '<path d="M56 64 a17 17 0 0 1 33 -4 l2 7 h-11 q-4 -5 -10 -5 h-14z" fill="#D4A83C"/><path d="M80 62 h11 q2 5 -2 7 h-9z" fill="#2A241E"/>'
      /* the bag between them */
      + '<g class="bag"><rect x="112" y="98" width="30" height="34" rx="3" fill="#C9A06A"/><path d="M118 98 q9 -12 18 0" fill="none" stroke="#8B6A48" stroke-width="2.5"/>'
      + '<text x="127" y="122" text-anchor="middle" font-family="Tajawal,sans-serif" font-size="13" font-weight="800" fill="#3A2E24">رف</text></g>'
      /* customer, receiving */
      + '<rect x="150" y="124" width="12" height="38" rx="4" fill="#5B4A3A"/><rect x="164" y="124" width="12" height="38" rx="4" fill="#5B4A3A"/>'
      + '<path d="M146 90 q17 -12 34 0 l2 38 h-38z" fill="#EFE2CC"/><path d="M150 96 q-10 4 -12 12" stroke="#EFE2CC" stroke-width="9" stroke-linecap="round" fill="none"/>'
      + '<circle cx="163" cy="70" r="13" fill="#D9A67E"/><path d="M151 66 q12 -16 25 0 q-2 -10 -12 -12 q-10 0 -13 12z" fill="#2E231B"/><path d="M152 74 q11 11 22 0 v5 q-11 9 -22 0z" fill="#2E231B"/>'
      + '<path d="M156 76 q7 5 14 0" stroke="#fff" stroke-width="1.6" fill="none"/>'
      + '</svg>'
  };
  /* ---------------------------------------------------------- scene images
     The three scenes are meant to be RENDERED ILLUSTRATIONS (the approved
     reference's soft-3D style), which hand-drawn SVG cannot reproduce. A page
     registers them here; until it does, the SVG drawings above are the
     fallback, so a missing asset never shows a broken image.
       RAFJourneyUI.useScenes({ store:url, ride:url, rideRtl:url, home:url })
     rideRtl is the rider facing LEFT, for the right-to-left (Arabic) journey:
     the approved render mirrored with its lettering restored, never a CSS flip. */
  var SCENES = { store:null, ride:null, rideRtl:null, home:null };
  function raster(){ return !!(SCENES.store && SCENES.ride && SCENES.home); }
  function useScenes(map){
    map = map || {};
    ['store', 'ride', 'rideRtl', 'home'].forEach(function (k) { SCENES[k] = typeof map[k] === 'string' && map[k] ? map[k] : null; });
    return raster();
  }
  var SKY =
    '<svg class="jr-sky" viewBox="0 0 1000 190" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
    + '<g fill="#EFE7D8" opacity=".75"><rect x="300" y="96" width="36" height="86"/><rect x="340" y="120" width="28" height="62"/><rect x="372" y="104" width="22" height="78"/>'
    + '<rect x="600" y="84" width="30" height="98"/><rect x="634" y="112" width="40" height="70"/><rect x="678" y="96" width="24" height="86"/><rect x="706" y="120" width="30" height="62"/></g>'
    + '<g class="cloud" fill="#F3ECDF"><ellipse cx="250" cy="44" rx="34" ry="15"/><ellipse cx="272" cy="36" rx="24" ry="15"/>'
    + '<ellipse cx="520" cy="34" rx="30" ry="13"/><ellipse cx="540" cy="27" rx="20" ry="13"/><ellipse cx="780" cy="58" rx="28" ry="12"/><ellipse cx="798" cy="51" rx="18" ry="11"/></g></svg>';

  /* the route, in a 1000×100 box; the three milestones sit ON it at x = 16.5 / 50 / 83.5 % */
  var PATH = 'M-20 56 C 60 56, 110 46, 165 50 S 280 76, 335 68 S 445 44, 500 50 S 610 76, 665 68 S 775 44, 835 50 S 960 60, 1020 54';
  var NODES = [ { x:16.5, y:50 }, { x:50, y:50 }, { x:83.5, y:50 } ];
  function road(){
    /* as in the reference: the road still ahead is a quiet dotted trace; the
       road travelled is a green band with a soft glow and a white centre line */
    return '<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
      + '<path d="' + PATH + '" fill="none" stroke="#D9D1C1" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 9" vector-effect="non-scaling-stroke"/>'
      + '</svg>'
      + '<div class="jr-prog"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
      + '<path d="' + PATH + '" fill="none" stroke="rgba(46,158,91,.16)" stroke-width="20" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '<path d="' + PATH + '" fill="none" stroke="#1F8A4C" stroke-width="10" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '<path d="' + PATH + '" fill="none" stroke="var(--jr-green)" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '<path class="jr-flow" d="' + PATH + '" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '</svg></div>';
  }
  var CHECK = '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICONS = ['ti-building-store', 'ti-motorbike', 'ti-home-check'];
  /* how far the green reaches: to the milestone reached (the last one: to the end) */
  function progressOf(stage, cancelled){ if (cancelled) return 0; return stage >= 2 ? 100 : NODES[stage].x; }

  /* orderId → the progress motion in flight. A page may re-render several
     times for one stage change (each write of the order record); a re-render
     during the motion continues from where the green is NOW, for the time
     left, instead of restarting or jumping to the end. */
  var MOTION = {}, DUR = 1400;
  function tNow(){ return (global.performance && performance.now) ? performance.now() : new Date().getTime(); }
  function ease(t){ return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function motionFor(id, target){
    var mo = MOTION[id], now = tNow();
    if (!mo) { MOTION[id] = { from:target, to:target, start:now - DUR }; return { from:target, dur:DUR }; }
    var k = Math.min(1, (now - mo.start) / DUR), at = mo.from + (mo.to - mo.from) * ease(k);
    if (mo.to !== target) { MOTION[id] = { from:at, to:target, start:now }; return { from:at, dur:DUR }; }
    if (k < 1) return { from:at, dur:Math.max(120, DUR - (now - mo.start)) };
    return { from:target, dur:DUR };
  }

  function html(m){
    injectCss();
    /* HANDOVER: the driver is at the door (the order's own arrival record). The
       journey moves on to its last milestone — Delivery / Handover — as the
       CURRENT step, not yet completed: the route is full, the home scene is live,
       and it becomes Delivered only when the order record says so */
    var handover = !!m.handover && !m.cancelled;
    var stage = handover ? 2 : Math.max(0, Math.min(2, m.stage | 0)), cancelled = !!m.cancelled, delivered = stage === 2 && !cancelled && !handover;
    function state(i){
      if (cancelled) return 'up';
      if (i < stage) return 'done';
      if (i === stage) return delivered ? 'done' : 'cur';
      return 'up';
    }
    var titles = [
      state(0) === 'cur' && !m.prepared ? T('جاري تجهيز طلبك', 'Preparing your order') : T('تم تجهيز طلبك', 'Order prepared'),
      T('قيد التوصيل', 'Out for delivery'),
      handover ? T('التسليم', 'Delivery / Handover') : T('تم التوصيل', 'Delivered')
    ];
    var target = progressOf(stage, cancelled);
    var mv = motionFor(m.orderId, target), from = Math.round(mv.from * 100) / 100;
    var s = m.store || {};

    /* header */
    var logo = s.logo
      ? '<span class="jr-logo"><img src="' + esc(s.logo) + '" alt="" onerror="this.parentNode.textContent=' + esc(JSON.stringify(s.initial || '')) + '"></span>'
      : '<span class="jr-logo" aria-hidden="true">' + esc(s.initial || '') + '</span>';
    var head = '<div class="jr-h">'
      + '<div class="jr-id jr-idrow">'
        + '<div class="jr-id">' + logo + '<div class="jr-store"><b>' + esc(s.name || '—') + '</b>' + (s.category ? '<span>' + esc(s.category) + '</span>' : '') + '</div></div>'
        + '<span class="jr-sep" aria-hidden="true"></span>'
        + '<div class="jr-no"><span>' + T('رقم الطلب', 'Order number') + '</span><b dir="ltr">' + esc(m.orderId) + '</b></div>'
      + '</div>'
      + '<div class="jr-st" aria-live="polite"><span class="jr-badge"><i aria-hidden="true"></i>' + esc(m.status.label) + '</span>'
        + '<span class="jr-msg">' + esc(m.status.message) + (delivered ? ' <i class="ti ti-heart-filled" aria-hidden="true"></i>' : '') + '</span></div>'
      + '</div>';

    /* the journey */
    var arts = ['store', 'ride', 'home'].map(function (k, i) {
      var st = state(i);
      var inner = SCENES[k]
        ? '<img class="jr-img jr-img-' + k + '" src="' + esc(k === 'ride' && !isEn() && SCENES.rideRtl ? SCENES.rideRtl : SCENES[k]) + '" alt="" draggable="false" decoding="async">'
        : ART[k];
      return '<div class="jr-art ' + st + (delivered && i === 2 ? ' done-last' : '') + '">' + inner + '</div>';
    }).join('');
    var nodes = NODES.map(function (n, i) {
      var st = state(i), final = delivered && i === 2;
      var inner = st === 'done' ? CHECK : '<i class="ti ' + ICONS[i] + '" aria-hidden="true"></i>';
      return '<span class="jr-node ' + (final ? 'final' : st) + '" style="--x:' + n.x + '%;--y:' + n.y + '%" aria-hidden="true">' + inner + '</span>';
    }).join('');
    var now = cancelled ? T('الطلب ملغى', 'Order cancelled')
      : T('المرحلة ' + (stage + 1) + ' من 3: ' + titles[stage], 'Stage ' + (stage + 1) + ' of 3: ' + titles[stage]);
    var journey = '<div class="jr-j">'
      + '<div class="jr-sc">' + SKY + arts + '</div>'
      + '<div class="jr-road" role="progressbar" aria-label="' + T('مراحل الطلب', 'Order progress') + '" aria-valuemin="1" aria-valuemax="3"'
        + ' aria-valuenow="' + (stage + 1) + '" aria-valuetext="' + esc(now) + '" data-from="' + from + '" data-to="' + target + '" style="--jr-p:' + from + '%;--jr-dur:' + Math.round(mv.dur) + 'ms">'
        + road() + nodes + '</div>'
      + (stage === 1 && !cancelled ? '<p class="jr-note" dir="' + (isEn() ? 'ltr' : 'rtl') + '">'
          + T('حالة التوصيل محدَّثة لحظيًا. التتبع على الخريطة غير متاح في هذه النسخة.', 'The delivery status is live. Map tracking is not available in this version.') + '</p>' : '')
      + '</div>';

    /* ---- below the journey: only what RAF actually holds ----
       compensation (a real one only) → delivery timer beside the driver →
       after delivery, the way to rate the order */
    var dirAttr = ' dir="' + (isEn() ? 'ltr' : 'rtl') + '"';
    var blocks = [];
    var c = m.compensation;
    if (c && !cancelled) blocks.push(compHTML(c, m.compNote));
    if (m.deliveryCode && !delivered && !cancelled) blocks.push(codeHTML(m.deliveryCode));
    var row = [];
    row.push(timerHTML(m, delivered, cancelled));
    /* the driver stays visible after delivery; only Call and Message end (m.canCall / m.canMessage) */
    if (m.driver && m.driver.name && !cancelled) row.push(driverHTML(m, delivered));
    if (delivered && m.rating) row.push(rateCtaHTML(m));
    if (!cancelled) blocks.push('<div class="jr-info">' + row.join('<span class="jr-vr" aria-hidden="true"></span>') + '</div>');
    if (m.callNote) blocks.push('<p class="jr-callnote" role="alert">' + esc(m.callNote) + '</p>');
    var foot = blocks.length ? '<div class="jr-f"' + dirAttr + '>' + blocks.join('') + '</div>' : '';

    var mid = [];
    if (!cancelled && !delivered) mid.push(etaHTML(m));
    var cl = clHTML(m, cancelled); if (cl) mid.push(cl);
    var midHtml = mid.length ? '<div class="jr-mid"' + dirAttr + '>' + mid.join('') + '</div>' : '';
    return '<section class="jr' + (cancelled ? ' is-cancelled' : '') + (raster() ? ' jr-raster' : '') + (isEn() ? '' : ' jr-rtl') + '" data-stage="' + stage + '"' + (handover ? ' data-handover="1"' : '') + ' aria-label="' + T('تتبع الطلب', 'Order tracking') + '">'
      + head + journey + midHtml + foot + '</section>';
  }

  /* ---------------------------------------------------- the lower section */
  function pad2(n){ return (n < 10 ? '0' : '') + n; }
  /* a digital elapsed duration, always HH:MM:SS so it never changes width */
  function hms(ms){
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }
  function durText(ms){
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return h > 0 ? T(h + ' س ' + m + ' د', h + ' h ' + m + ' min') : T(m + ' د ' + sec + ' ث', m + ' min ' + sec + ' sec');
  }
  function dateOf(ms){
    try { return new Date(ms).toLocaleDateString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'long', year:'numeric' }); }
    catch (e) { return null; }
  }
  /* THE DELIVERY TIMER — from the store's acceptance (the audited 'order.accept'
     milestone) to delivery (the audited 'driver.delivered' milestone). The page
     passes both; nothing here is derived from when the page was opened. */
  function timerHTML(m, delivered, cancelled){
    var start = typeof m.acceptedAt === 'number' ? m.acceptedAt : null;
    var end = delivered && typeof m.deliveredAt === 'number' ? m.deliveredAt : null;
    var running = !!start && !end && !cancelled && !delivered;
    /* delivered: a finished duration, written out ("3 h 45 min") — static, not a clock */
    var shown = !start ? '--:--:--' : end ? durText(end - start) : hms(Date.now() - start);
    var label = delivered ? T('مدة التوصيل', 'Delivery time') : T('مؤقت التوصيل', 'Delivery timer');
    var sub = !start ? T('يبدأ عند قبول المتجر لطلبك', 'Starts when the store accepts your order')
            : delivered ? T('من قبول المتجر حتى التسليم', 'From store acceptance to delivery')
            : T('منذ قبول المتجر لطلبك', 'Since the store accepted your order');
    return '<div class="jr-timer' + (running ? ' on' : '') + '"' + (start ? ' data-jr-timer data-start="' + start + '"' + (end ? ' data-end="' + end + '"' : '') : '') + '>'
      + '<span class="ic" aria-hidden="true"><i class="ti ti-clock-hour-4"></i></span>'
      + '<div><span>' + label + (running ? '<i class="jr-live" aria-hidden="true"></i>' : '') + '</span>'
      + '<b class="jr-clock' + (end ? ' done' : '') + '" dir="' + (end ? 'auto' : 'ltr') + '"' + (end ? '' : ' role="timer"') + ' aria-label="' + esc(label + ': ' + shown) + '">' + shown + '</b>'
      + '<small>' + sub + '</small></div></div>';
  }
  /* the driver — only while a live conversation exists (RAFDriverCommunication);
     the rating is the average of real submitted ratings, or honestly none */
  function driverHTML(m, delivered){
    var d = m.driver, r = d.rating;
    var rate = (r && r.count > 0 && typeof r.average === 'number')
      ? '<span class="jr-stars" aria-label="' + esc(T('تقييم السائق ' + r.average.toFixed(1) + ' من 5 من ' + r.count + ' تقييم', 'Driver rating ' + r.average.toFixed(1) + ' of 5 from ' + r.count + ' rating' + (r.count === 1 ? '' : 's'))) + '">'
        + '<i class="ti ti-star-filled" aria-hidden="true"></i><bdi dir="ltr">' + r.average.toFixed(1) + '</bdi>'
        + '<em>(' + T(r.count + ' تقييم', r.count + (r.count === 1 ? ' rating' : ' ratings')) + ')</em></span>'
      : '<span class="jr-stars none">' + T('لا توجد تقييمات بعد', 'No ratings yet') + '</span>';
    return '<div class="jr-drv"><span class="jr-av" aria-hidden="true">' + esc(String(d.name).trim().charAt(0)) + '</span>'
      + '<div><span>' + (delivered ? T('وصّل طلبك', 'Delivered by') : T('سائق التوصيل', 'Your driver')) + '</span><b>' + esc(d.name) + '</b>' + rate + '</div>'
      + (!delivered && (m.canCall || m.canMessage) ? '<div class="jr-acts">'
        + (m.canCall ? '<button type="button" class="jr-ic" data-jr="call" aria-label="' + esc(T('اتصال بالسائق', 'Call the driver')) + '" title="' + esc(T('اتصال', 'Call')) + '"><i class="ti ti-phone" aria-hidden="true"></i></button>' : '')
        + (m.canMessage ? '<button type="button" class="jr-ic" data-jr="message" aria-label="'
            + esc(T('مراسلة السائق', 'Message the driver') + (m.unread > 0 ? ' — ' + T(m.unread + ' رسالة غير مقروءة', m.unread + ' unread message' + (m.unread === 1 ? '' : 's')) : ''))
            + '" title="' + esc(T('مراسلة', 'Message')) + '"><i class="ti ti-message-dots" aria-hidden="true"></i>'
            /* the unread count — the communication authority's own receipts, this order only */
            + (m.unread > 0 ? '<span class="jr-unread" aria-hidden="true">' + (m.unread > 99 ? '99+' : m.unread) + '</span>' : '')
            + '</button>' : '')
        + '</div>' : '')
      + '</div>';
  }
  /* THE ETA — the DELIVERY estimate only. RAF holds none today (the merchant's
     Promised ETA is a different value and is never presented as one), so the
     line reads "—" and says so. It fills itself from m.deliveryEtaAt the day a
     delivery authority records one. The value box has a fixed minimum width. */
  function etaMinutes(at){ return Math.max(0, Math.ceil((at - Date.now()) / 60000)); }
  function etaHTML(m){
    var has = typeof m.deliveryEtaAt === 'number';
    var v = has ? T(etaMinutes(m.deliveryEtaAt) + ' دقيقة', etaMinutes(m.deliveryEtaAt) + ' min') : '—';
    return '<div class="jr-eta" role="group" aria-label="' + esc(T('الوقت المتوقع للتوصيل', 'Estimated delivery')) + '"' + (has ? ' data-jr-eta="' + m.deliveryEtaAt + '"' : '') + '>'
      + '<span class="ic" aria-hidden="true"><i class="ti ti-clock-share"></i></span>'
      + '<div class="jr-eta-b"><span>' + T('الوقت المتوقع للتوصيل', 'Estimated delivery') + '</span><b class="jr-eta-v" dir="auto">' + esc(v) + '</b></div>'
      + (has ? '' : '<small>' + T('لا يتوفر وقت توصيل مؤكد لهذا الطلب بعد.', 'No confirmed delivery time is available for this order yet.') + '</small>')
      + '</div>';
  }
  /* THE COMPENSATION LINE — a second, independent line, drawn only once a real
     compensation process exists, in sequence:
       1 · live delay (RAFCompensation.liveDelay, an estimate): from the moment
           the delay passes the excluded minutes, one marker per step of the
           approved rules; the fill is elapsed time against the steps drawn
       2 · the issued coupon (RAFCompensation.forOrder): issuance → expiry, with
           "added to wallet" as its completion; frozen once complete
     Everything is computed from recorded timestamps, so a refresh or reopening
     tracking lands on the same point. */
  function clLiveInner(start, step, per, now){
    var el = Math.max(0, now - start), blocks = Math.floor(el / step), K = Math.max(3, blocks + 1);
    var fill = Math.min(100, el / (K * step) * 100), marks = '';
    for (var i = 1; i <= K; i++) marks += '<span class="jr-cl-k' + (i <= blocks ? ' on' : '') + '" style="--at:' + (i / K * 100) + '%" aria-hidden="true">1<em>+' + esc(per) + '</em></span>';
    var next = step - (el % step), mm = Math.floor(next / 60000), ss = Math.floor(next / 1000) % 60;
    return { track:'<span class="jr-cl-f" style="width:' + fill.toFixed(2) + '%"></span>' + marks, blocks:blocks,
             next:(mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss };
  }
  function clHTML(m, cancelled){
    if (cancelled) return '';
    var c = m.compensation, L = m.compLive;
    if (c) {
      var done = !(c.status === 'issued' || c.status === 'add_pending');
      var span = Math.max(1, c.expiresAt - c.issuedAt);
      var addedAt = c.wallet && c.wallet.added && typeof c.wallet.addedAt === 'number' ? c.wallet.addedAt : null;
      var endAt = done ? (addedAt || Math.min(Date.now(), c.expiresAt)) : Date.now();
      var fill = Math.max(0, Math.min(100, (endAt - c.issuedAt) / span * 100));
      var st = COMP_STATUS[c.status] || null;
      return '<div class="jr-cl' + (done ? ' done' : '') + '" role="group" aria-label="' + esc(T('تعويض التأخير', 'Delay compensation')) + '"'
        + (done ? '' : ' data-jr-cl="coupon" data-start="' + c.issuedAt + '" data-end="' + c.expiresAt + '"') + '>'
        + '<div class="jr-cl-h"><i class="ti ' + (done ? 'ti-circle-check' : 'ti-gift') + '" aria-hidden="true"></i>' + T('تعويض التأخير', 'Delay compensation') + '</div>'
        + '<p class="jr-cl-m">' + (done ? (st ? T(st.ar, st.en) + ' — ' : '') + T('اكتملت مرحلة التعويض.', 'The compensation is complete.')
                                     : T('صدرت قسيمة تعويض بقيمة ', 'A compensation coupon of ') + '<bdi dir="ltr">' + esc(c.amount) + '</bdi> ' + T('د.ك — أضفها إلى محفظة رف قبل انتهاء صلاحيتها.', 'KWD was issued — add it to your RAF Wallet before it expires.')) + '</p>'
        + '<div class="jr-cl-t" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(fill) + '">'
          + '<span class="jr-cl-f" style="width:' + fill.toFixed(2) + '%"></span>'
          + '<span class="jr-cl-k on" style="--at:0%" aria-hidden="true">1<em>' + T('صدرت', 'Issued') + '</em></span>'
          + (addedAt ? '<span class="jr-cl-k on" style="--at:' + Math.max(8, Math.min(92, (addedAt - c.issuedAt) / span * 100)).toFixed(2) + '%" aria-hidden="true">2<em>' + T('أُضيفت', 'Added') + '</em></span>'
                     : '<span class="jr-cl-k" style="--at:50%" aria-hidden="true">2<em>' + T('إضافتها للمحفظة', 'Add to wallet') + '</em></span>')
          + '<span class="jr-cl-k' + (c.status === 'expired' ? ' on' : '') + '" style="--at:100%" aria-hidden="true">3<em>' + T('تنتهي', 'Expires') + '</em></span>'
        + '</div>'
        + '<div class="jr-cl-s"><span>' + T('المبلغ: ', 'Amount: ') + '<b dir="ltr">' + esc(c.amount) + '</b> ' + T('د.ك', 'KWD') + '</span>'
          + '<span>' + T('صالحة حتى ', 'Valid until ') + '<b>' + esc(dateOf(c.expiresAt) || '—') + '</b></span></div>'
        + '</div>';
    }
    if (L && L.started) {
      var inner = clLiveInner(L.startsAt, L.stepMs, L.amountPerStep, Date.now());
      return '<div class="jr-cl" role="group" aria-label="' + esc(T('تعويض التأخير', 'Delay compensation')) + '" data-jr-cl="live"'
        + ' data-start="' + L.startsAt + '" data-step="' + L.stepMs + '" data-per="' + esc(L.amountPerStep) + '" data-perfils="' + L.amountPerStepFils + '">'
        + '<div class="jr-cl-h"><i class="ti ti-hourglass-high" aria-hidden="true"></i>' + T('تعويض التأخير', 'Delay compensation') + '</div>'
        + '<p class="jr-cl-m">' + T('تأخر طلبك عن الوقت الذي وعد به المتجر، وبدأ احتساب تعويض التأخير. يُحتسب المبلغ نهائيًا عند تسليم طلبك.',
                                    'Your order is past the time the store promised, and delay compensation has started. The final amount is set when your order is delivered.') + '</p>'
        + '<div class="jr-cl-t" role="progressbar" aria-valuemin="0" aria-valuemax="100">' + inner.track + '</div>'
        + '<div class="jr-cl-s"><span>' + T('التقدير حتى الآن: ', 'Estimate so far: ') + '<b dir="ltr" data-cl-amt>' + esc((inner.blocks * L.amountPerStepFils / 1000).toFixed(3)) + '</b> ' + T('د.ك', 'KWD') + '</span>'
          + '<span>' + T('الخطوة التالية بعد ', 'Next step in ') + '<b dir="ltr" data-cl-next>' + inner.next + '</b></span></div>'
        + '</div>';
    }
    return '';
  }
  /* THE DELIVERY VERIFICATION CODE — issued by RAFLogistics when the driver
     arrived and read from the order's own record; the customer hands it over
     at the door. Nothing here generates or stores it. */
  function codeHTML(code){
    return '<div class="jr-code" role="group" aria-label="' + esc(T('رمز التحقق من التسليم', 'Delivery Verification Code')) + '">'
      + '<span class="jr-code-ic" aria-hidden="true"><i class="ti ti-shield-check"></i></span>'
      + '<div class="jr-code-b"><b>' + T('رمز التحقق من التسليم', 'Delivery Verification Code') + '</b>'
      + '<p>' + T('وصل السائق. أعطِ السائق هذا الرمز عند استلام طلبك — لا يمكنه تسليم الطلب بدونه.',
                  'Your driver has arrived. Give this code to the driver when you receive your order — the delivery cannot be confirmed without it.') + '</p></div>'
      + '<b class="jr-code-n" dir="ltr" aria-label="' + esc(T('الرمز ', 'Code ') + String(code).split('').join(' ')) + '">' + esc(code) + '</b>'
      + '</div>';
  }
  function rateCtaHTML(m){
    if (m.rating.state === 'rated')
      return '<div class="jr-rated"><i class="ti ti-circle-check" aria-hidden="true"></i><span>' + T('شكرًا لك، تم تقييم هذا الطلب.', 'Thank you — this order has been rated.') + '</span></div>';
    return '<a class="jr-btn jr-rate" href="raf_delivery_rating.html?id=' + encodeURIComponent(m.orderId) + '">'
      + '<i class="ti ti-star" aria-hidden="true"></i>' + T('تقييم الطلب', 'Rate your order') + '</a>';
  }
  /* COMPENSATION — drawn only from a real RAFCompensation record for this order */
  var COMP_STATUS = {
    issued:     { ar:'بانتظار إضافتها إلى محفظتك', en:'Ready to add to your wallet' },
    add_pending:{ ar:'جارٍ إضافتها إلى محفظتك',    en:'Being added to your wallet' },
    in_wallet:  { ar:'أُضيفت إلى محفظة رف',        en:'Added to your RAF Wallet' },
    consumed:   { ar:'استُخدمت بالكامل',            en:'Fully used' },
    expired:    { ar:'انتهت صلاحيتها',              en:'Expired' },
    voided:     { ar:'أُلغيت',                      en:'Cancelled' },
    reversed:   { ar:'أُلغيت',                      en:'Cancelled' }
  };
  function compHTML(c, note){
    var st = COMP_STATUS[c.status] || null, exp = dateOf(c.expiresAt);
    var msg = c.message ? (isEn() ? (c.message.en || c.message.ar) : (c.message.ar || c.message.en)) : null;
    return '<div class="jr-comp" role="group" aria-label="' + esc(T('تعويض التأخير', 'Delay compensation')) + '">'
      + '<div class="jr-comp-stub" aria-hidden="true"><i class="ti ti-gift"></i></div>'
      + '<div class="jr-comp-b">'
        + '<span class="jr-comp-k">' + T('قسيمة تعويض عن تأخير التوصيل', 'Late-delivery compensation coupon') + '</span>'
        + '<b class="jr-comp-amt"><bdi dir="ltr">' + esc(c.amount) + '</bdi> ' + T('د.ك', 'KWD') + '</b>'
        + (msg ? '<p class="jr-comp-msg">' + esc(msg) + '</p>' : '')
        + '<div class="jr-comp-meta">'
          + (st ? '<span class="jr-comp-st s-' + esc(c.status) + '">' + T(st.ar, st.en) + '</span>' : '')
          + (exp && (c.status === 'issued' || c.status === 'add_pending' || c.status === 'in_wallet') ? '<span>' + T('صالحة حتى ', 'Valid until ') + '<bdi>' + esc(exp) + '</bdi></span>' : '')
        + '</div>'
        + (note ? '<p class="jr-callnote" role="alert">' + esc(note) + '</p>' : '')
      + '</div>'
      + (c.canAddToWallet ? '<button type="button" class="jr-btn jr-comp-cta" data-jr="wallet"><i class="ti ti-wallet" aria-hidden="true"></i>' + T('أضف إلى محفظة رف', 'Add to RAF Wallet') + '</button>' : '')
      + '</div>';
  }

  /* the running timers tick once a second — a clock, not a data poll: the
     order itself is re-read only when its authorities publish a change */
  var TICK = null;
  function tick(){
    var live = document.querySelectorAll('[data-jr-timer]:not([data-end])');
    var cls = document.querySelectorAll('[data-jr-cl]'), etas = document.querySelectorAll('[data-jr-eta]');
    Array.prototype.forEach.call(cls, function (el) {
      var t = el.querySelector('.jr-cl-t'), start = +el.getAttribute('data-start'); if (!t || !start) return;
      if (el.getAttribute('data-jr-cl') === 'live') {
        var r = clLiveInner(start, +el.getAttribute('data-step'), el.getAttribute('data-per'), Date.now());
        t.innerHTML = r.track;
        var a = el.querySelector('[data-cl-amt]'); if (a) a.textContent = (r.blocks * (+el.getAttribute('data-perfils')) / 1000).toFixed(3);
        var nx = el.querySelector('[data-cl-next]'); if (nx) nx.textContent = r.next;
      } else {
        var end = +el.getAttribute('data-end'), f = el.querySelector('.jr-cl-f');
        if (f && end > start) f.style.width = Math.max(0, Math.min(100, (Date.now() - start) / (end - start) * 100)).toFixed(2) + '%';
      }
    });
    Array.prototype.forEach.call(etas, function (el) {
      var b = el.querySelector('.jr-eta-v'); if (b) b.textContent = T(etaMinutes(+el.getAttribute('data-jr-eta')) + ' دقيقة', etaMinutes(+el.getAttribute('data-jr-eta')) + ' min');
    });
    if (!live.length && !cls.length && !etas.length) { clearInterval(TICK); TICK = null; return; }
    Array.prototype.forEach.call(live, function (el) {
      var b = el.querySelector('.jr-clock'), start = +el.getAttribute('data-start'); if (!b || !start) return;
      var v = hms(Date.now() - start); b.textContent = v;
      var lab = el.querySelector('div > span'); b.setAttribute('aria-label', (lab ? lab.textContent : '') + ': ' + v);
    });
  }

  /* move the green from where this page last drew it to where the order is now */
  function settle(root){
    if (document.querySelector('[data-jr-timer]:not([data-end]), [data-jr-cl], [data-jr-eta]') && !TICK) TICK = setInterval(tick, 1000);
    var r = root && root.querySelector ? root.querySelector('.jr-road') : null; if (!r) return;
    var to = r.getAttribute('data-to');
    if (r.getAttribute('data-from') === to) return;
    requestAnimationFrame(function () { requestAnimationFrame(function () { r.style.setProperty('--jr-p', to + '%'); }); });
  }

  global.RAFJourneyUI = { html:html, settle:settle, useScenes:useScenes };
})(window);
