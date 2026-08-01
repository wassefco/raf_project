/* ============================================================
   RAF Catalog — shared product source for the Quick Order page.
   Keyed by product id so any listing can deep-link into Quick Order.
   Falls back to RAFShop.catalog, then to RAFCard.guessVariants, so
   unknown ids still render with sensible required options.
   ============================================================ */
(function () {
  if (window.RAFCatalog) return;

  function sizes(arr){ return { label:{ar:'المقاس',en:'Size'}, options:arr.map(function(v){ return {v:String(v).toLowerCase(), label:{ar:String(v),en:String(v)}}; }) }; }
  function colors(list){ return { label:{ar:'اللون',en:'Color'}, options:list.map(function(c){ return {v:c.v, label:{ar:c.ar,en:c.en}, hex:c.hex}; }) }; }

  var C = {
    /* ── homepage / featured ── */
    'P-EARBUDS':{ ar:'سماعات لاسلكية فاخرة', en:'Premium Wireless Earbuds', store:'تك هاوس', storeEn:'Tech House', slug:'techzone',
      price:'24.500', old:'35.000', disc:30, rate:'4.8', rev:'320', ic:'ti-device-mobile', stock:14,
      desc:{ar:'صوت نقي وعزل ضوضاء نشط مع علبة شحن سريعة.',en:'Crisp sound with active noise cancelling and fast-charge case.'} },
    'P-PERFUME':{ ar:'عطر شرقي فاخر', en:'Luxury Oriental Perfume', store:'دار العود', storeEn:'Dar Aloud', slug:'dar-aloud',
      price:'42.000', old:'60.000', disc:30, rate:'4.9', rev:'215', ic:'ti-spray', stock:8,
      desc:{ar:'مزيج شرقي فاخر من العود والمسك يدوم طويلاً.',en:'A rich oriental blend of oud and musk with long-lasting sillage.'},
      variants:[{ label:{ar:'الحجم',en:'Size'}, options:[{v:'50',label:{ar:'50 مل',en:'50 ml'}},{v:'100',label:{ar:'100 مل',en:'100 ml'}},{v:'150',label:{ar:'150 مل',en:'150 ml'}}] }] },
    'P-WATCH':{ ar:'ساعة كلاسيكية جلد', en:'Classic Leather Watch', store:'تايم بوكس', storeEn:'Time Box', slug:'time-box',
      price:'68.000', old:'85.000', disc:20, rate:'4.7', rev:'142', ic:'ti-clock-hour-4', stock:5,
      desc:{ar:'تصميم كلاسيكي بسوار جلد طبيعي وحركة دقيقة.',en:'Classic design with a genuine leather strap and precise movement.'},
      variants:[ colors([{v:'brown',ar:'جلد بني',en:'Brown Leather',hex:'#8B5A2B'},{v:'black',ar:'جلد أسود',en:'Black Leather',hex:'#1A1A1A'}]) ] },
    'P-JACKET':{ ar:'جاكيت شتوي عصري', en:'Modern Winter Jacket', store:'كازا مود', storeEn:'Casa Mode', slug:'casa-mode',
      price:'29.900', old:'45.000', disc:33, rate:'4.6', rev:'98', ic:'ti-hanger', stock:11,
      desc:{ar:'جاكيت خفيف مبطّن يوفر دفئاً عالياً بمظهر أنيق.',en:'Lightweight padded jacket offering high warmth with a sharp look.'},
      variants:[ sizes(['S','M','L','XL']), colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'navy',ar:'كحلي',en:'Navy',hex:'#1B2A4A'},{v:'olive',ar:'زيتي',en:'Olive',hex:'#5B6236'}]) ] },
    'P-HEADPHONES':{ ar:'سماعة رأس احترافية', en:'Pro Headphones', store:'تك هاوس', storeEn:'Tech House', slug:'techzone',
      price:'38.000', old:'52.000', disc:27, rate:'4.8', rev:'410', ic:'ti-headphones', stock:0,
      desc:{ar:'سماعة احترافية بعزل ضوضاء وبطارية تدوم 40 ساعة.',en:'Studio-grade headphones with ANC and 40-hour battery.'},
      variants:[ colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'white',ar:'أبيض',en:'White',hex:'#F2F0EA'}]),
                 { label:{ar:'السعة',en:'Storage'}, options:[{v:'std',label:{ar:'قياسي',en:'Standard'}},{v:'plus',label:{ar:'بلس (ذاكرة)',en:'Plus (memory)'}}] } ] },

    /* ── offers page ── */
    'P-001':{ ar:'قميص أوفرسايز كلاسيك', en:'Classic Oversize Shirt', store:'Casa Mode', storeEn:'Casa Mode', slug:'casa-mode',
      price:'12.000', old:'17.000', disc:30, rate:'4.8', rev:'124', ic:'ti-shirt', stock:15,
      desc:{ar:'قطن 100% بقصّة أوفرسايز مريحة تناسب كل الأوقات.',en:'100% cotton with a relaxed oversize cut for any occasion.'},
      variants:[ sizes(['S','M','L','XL']), colors([{v:'white',ar:'أبيض',en:'White',hex:'#F2F0EA'},{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'navy',ar:'كحلي',en:'Navy',hex:'#1B2A4A'}]) ] },
    'P-002':{ ar:'حذاء رياضي Air Comfort', en:'Air Comfort Sneakers', store:'Sole & Co', storeEn:'Sole & Co', slug:'sole-co',
      price:'28.500', old:'38.000', disc:25, rate:'4.7', rev:'89', ic:'ti-shoe', stock:9,
      desc:{ar:'نعل مريح خفيف الوزن مناسب للاستخدام اليومي.',en:'Lightweight cushioned sole built for all-day wear.'},
      variants:[ sizes([40,41,42,43,44]) ] },
    'P-003':{ ar:'iPhone 16 Pro', en:'iPhone 16 Pro', store:'TechZone', storeEn:'TechZone', slug:'techzone',
      price:'189.000', old:'220.000', disc:15, rate:'5.0', rev:'210', ic:'ti-device-mobile', stock:6,
      desc:{ar:'أداء فائق وكاميرا احترافية بضمان رسمي.',en:'Flagship performance and a pro camera, with official warranty.'},
      variants:[ { label:{ar:'السعة',en:'Storage'}, options:[{v:'128',label:{ar:'128GB',en:'128GB'}},{v:'256',label:{ar:'256GB',en:'256GB'}},{v:'512',label:{ar:'512GB',en:'512GB'}}] },
                 colors([{v:'ti',ar:'تيتانيوم',en:'Titanium',hex:'#8E8E93'},{v:'bk',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'wt',ar:'أبيض',en:'White',hex:'#F2F0EA'}]) ] },
    'P-004':{ ar:'نظارة شمسية Ray Luxe', en:'Ray Luxe Sunglasses', store:'Luxe Accessories', storeEn:'Luxe Accessories', slug:'luxe-accessories',
      price:'35.000', old:'58.000', disc:40, rate:'4.6', rev:'67', ic:'ti-sunglasses', stock:12,
      desc:{ar:'عدسات مستقطبة بحماية كاملة من الأشعة.',en:'Polarised lenses with full UV protection.'} },
    'P-005':{ ar:'حقيبة يد جلد طبيعي', en:'Genuine Leather Handbag', store:'Casa Mode', storeEn:'Casa Mode', slug:'casa-mode',
      price:'35.700', old:'42.000', disc:15, rate:'4.9', rev:'152', ic:'ti-backpack', stock:7,
      desc:{ar:'جلد طبيعي بخياطة يدوية وتصميم عملي أنيق.',en:'Genuine hand-stitched leather in an elegant, practical design.'},
      variants:[ colors([{v:'brown',ar:'بني',en:'Brown',hex:'#8B5A2B'},{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'}]) ] },
    'P-006':{ ar:'ساعة ذكية Premium', en:'Premium Smartwatch', store:'Glam Store', storeEn:'Glam Store', slug:'glam-store',
      price:'75.000', old:'94.000', disc:20, rate:'4.8', rev:'98', ic:'ti-watch', stock:10,
      desc:{ar:'تتبع صحي متكامل وشاشة AMOLED دائمة العمل.',en:'Full health tracking with an always-on AMOLED display.'},
      variants:[ colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'silver',ar:'فضي',en:'Silver',hex:'#C9CBD1'}]) ] },
    'P-007':{ ar:'فستان سهرة بولدر', en:'Boulder Evening Dress', store:'Casa Mode', storeEn:'Casa Mode', slug:'casa-mode',
      price:'30.000', old:'60.000', disc:50, rate:'4.7', rev:'44', ic:'ti-hanger', stock:4,
      desc:{ar:'تصميم أنيق بخامة فاخرة يناسب المناسبات.',en:'An elegant cut in premium fabric, made for occasions.'},
      variants:[ sizes(['S','M','L']), colors([{v:'red',ar:'أحمر',en:'Red',hex:'#8E2B2B'},{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'}]) ] },
    'P-008':{ ar:'سماعة Sony WH-1000XM5', en:'Sony WH-1000XM5', store:'TechZone', storeEn:'TechZone', slug:'techzone',
      price:'35.750', old:'55.000', disc:35, rate:'4.9', rev:'201', ic:'ti-headphones', stock:5,
      desc:{ar:'أفضل عزل ضوضاء في فئتها مع صوت غني.',en:'Best-in-class noise cancelling with rich, warm sound.'},
      variants:[ colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'silver',ar:'فضي',en:'Silver',hex:'#C9CBD1'}]) ] }
  };

  /* store display name → slug, so Quick Order can always reach the Store page */
  var SLUGS = { 'Casa Mode':'casa-mode','كازا مود':'casa-mode','Sole & Co':'sole-co','TechZone':'techzone','تك هاوس':'techzone',
                'دار العود':'dar-aloud','تايم بوكس':'time-box','Glam Store':'glam-store','لمسة ذهب':'lamsa-gold',
                'Luxe Accessories':'luxe-accessories' };

  function slugFor(name){
    if (!name) return 'casa-mode';
    if (SLUGS[name]) return SLUGS[name];
    return String(name).trim().toLowerCase().replace(/&/g,'').replace(/\s+/g,'-').replace(/-+/g,'-');
  }

  window.RAFCatalog = {
    slugFor: slugFor,
    /* Resolve a product by id from the catalog, then the shared shop catalog. */
    get: function (id) {
      var p = C[id];
      if (p) {
        return {
          id:id, ar:p.ar, en:p.en, price:p.price, old:p.old||'', disc:p.disc||0,
          rate:p.rate||'', rev:p.rev||'', ic:p.ic||'ti-box',
          stock: (p.stock == null ? 10 : p.stock),
          desc:p.desc || null,
          store:{ ar:p.store, en:p.storeEn || p.store },
          slug:p.slug || slugFor(p.store),
          variants:p.variants || null
        };
      }
      /* fall back to the shared shop catalog (search / wishlist items) */
      var s = (window.RAFShop && RAFShop.catalog || []).find(function (x) { return x.sku === id; });
      if (s) {
        var inferred = (window.RAFCard && RAFCard.guessVariants) ? RAFCard.guessVariants('', s.ar + ' ' + s.en) : null;
        return { id:id, ar:s.ar, en:s.en, price:s.price, old:'', disc:0, rate:'', rev:'', ic:s.ic||'ti-box',
                 stock:10, desc:null, store:s.store, slug:slugFor(s.store && s.store.en), variants:inferred };
      }
      return null;
    }
  };
})();
