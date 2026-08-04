/* ============================================================================
 * RAF Marketplace — CENTRAL DATA AUTHORITY  (Single Source of Truth)
 * ----------------------------------------------------------------------------
 * One canonical dataset for Products · Stores · Prices · Discounts · Offers ·
 * Availability · Store Status · Product Status · Categories.
 *
 * Migration contract (deliberately conservative):
 *   • Loaded BEFORE raf_data.js / raf_catalog.js.
 *   • It does NOT change any page's API. Instead the existing accessors
 *     (RAFCatalog.get / RAFCatalog.slugFor / RAFShop.catalog) are re-pointed at
 *     this dataset by thin adapters, so pages that were never touched keep
 *     working exactly as before while already reading centralized data.
 *   • Page-local arrays are then retired one page at a time.
 *
 * Nothing here mutates storage. Runtime overrides (an admin editing a price,
 * a store closing) live in localStorage 'raf_source_overrides' and are layered
 * on top of the base data at read time, which is what makes a change in one
 * place appear everywhere.
 * ==========================================================================*/
(function (global) {
  if (global.RAFSource) return;

  var LS_OVERRIDES = 'raf_source_overrides';

  /* ---------- status vocabularies ---------- */
  var STORE_STATUS   = { OPEN:'open', CLOSED:'closed', SUSPENDED:'suspended', DELETED:'deleted' };
  var PRODUCT_STATUS = { ACTIVE:'active', HIDDEN:'hidden', DELETED:'deleted' };

  /* ---------- categories (canonical keys used by every listing) ---------- */
  var CATEGORIES = [
    { k:'electronics', ar:'إلكترونيات', en:'Electronics',  ic:'ti-device-mobile', sort:1 },
    { k:'fashion',     ar:'أزياء',      en:'Fashion',      ic:'ti-hanger',        sort:2 },
    { k:'shoes',       ar:'أحذية',      en:'Shoes',        ic:'ti-shoe',          sort:3 },
    { k:'bags',        ar:'حقائب',      en:'Bags',         ic:'ti-backpack',      sort:4 },
    { k:'watches',     ar:'ساعات',      en:'Watches',      ic:'ti-clock-hour-4',  sort:5 },
    { k:'perfume',     ar:'عطور',       en:'Perfume',      ic:'ti-spray',         sort:6 },
    { k:'jewelry',     ar:'مجوهرات',    en:'Jewelry',      ic:'ti-diamond',       sort:7 },
    { k:'accessories', ar:'إكسسوارات',  en:'Accessories',  ic:'ti-sunglasses',    sort:8 }
  ];

  /* ---------- variant builders (shared shapes) ---------- */
  function sizes(a){ return { label:{ar:'المقاس',en:'Size'}, options:a.map(function(v){ return {v:String(v).toLowerCase(), label:{ar:String(v),en:String(v)}}; }) }; }
  function colors(l){ return { label:{ar:'اللون',en:'Color'}, options:l.map(function(c){ return {v:c.v, label:{ar:c.ar,en:c.en}, hex:c.hex}; }) }; }
  var C_BW  = colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'white',ar:'أبيض',en:'White',hex:'#F2F0EA'}]);
  var C_BWN = colors([{v:'white',ar:'أبيض',en:'White',hex:'#F2F0EA'},{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'navy',ar:'كحلي',en:'Navy',hex:'#1B2A4A'}]);
  var C_BS  = colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'silver',ar:'فضي',en:'Silver',hex:'#C9CBD1'}]);
  var C_BRB = colors([{v:'brown',ar:'بني',en:'Brown',hex:'#8B5A2B'},{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'}]);

  /* ---------- product factory ----------
     P(id, ar, en, price, old, disc, rate, rev, ic, cat, stock, extra) */
  function P(id, ar, en, price, old, disc, rate, rev, ic, cat, stock, extra){
    var p = { id:id, name:{ar:ar,en:en}, price:price, old:old||'', disc:disc||0,
              rate:String(rate||''), rev:String(rev||''), ic:ic||'ti-box', images:[],
              cat:cat||'', stock:(stock==null?10:stock), status:PRODUCT_STATUS.ACTIVE,
              variants:null, desc:null, sponsored:false };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) p[k] = extra[k];
    return p;
  }

  /* ---------- STORES + their products ---------- */
  var RAW = [
    { slug:'casa-mode', name:{ar:'Casa Mode',en:'Casa Mode'}, num:'#001', ic:'ti-hanger',
      cover:'', cat:{ar:'ملابس وأزياء',en:'Fashion & Apparel'}, rating:'4.9', orders:'1,284',
      followers:'3.2K', productCount:284, satisfaction:'98%', reviewCount:128, reviewScore:'4.9',
      status:STORE_STATUS.OPEN, sponsored:true,
      hours:{ ar:'السبت – الخميس: 10ص – 11م · الجمعة: 2م – 11م', en:'Sat–Thu: 10am – 11pm · Fri: 2pm – 11pm' },
      desc:{ar:'متجر Casa Mode للملابس والأزياء العصرية — نقدم أحدث صيحات الموضة بجودة عالية وأسعار منافسة. نخدم الكويت منذ 2019.',
             en:'Casa Mode brings contemporary fashion to Kuwait — the latest trends in premium quality at competitive prices. Serving since 2019.'},
      cats:['fashion','bags'],
      items:[
        P('P-001','قميص أوفرسايز كلاسيك','Classic Oversize Shirt','12.000','17.000',30,'4.8','124','ti-shirt','fashion',15,
          {variants:[sizes(['S','M','L','XL']),C_BWN],
           desc:{ar:'قطن 100% بقصّة أوفرسايز مريحة تناسب كل الأوقات.',en:'100% cotton with a relaxed oversize cut for any occasion.'}}),
        P('P-007','فستان سهرة بولدر','Boulder Evening Dress','30.000','60.000',50,'4.7','44','ti-hanger','fashion',4,
          {variants:[sizes(['S','M','L']),colors([{v:'red',ar:'أحمر',en:'Red',hex:'#8E2B2B'},{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'}])],
           desc:{ar:'تصميم أنيق بخامة فاخرة يناسب المناسبات.',en:'An elegant cut in premium fabric, made for occasions.'}}),
        P('P-005','حقيبة يد جلد طبيعي','Genuine Leather Handbag','35.700','42.000',15,'4.9','152','ti-backpack','bags',7,
          {variants:[C_BRB], desc:{ar:'جلد طبيعي بخياطة يدوية وتصميم عملي أنيق.',en:'Genuine hand-stitched leather in an elegant, practical design.'}}),
        P('P-JACKET','جاكيت شتوي عصري','Modern Winter Jacket','29.900','45.000',33,'4.6','98','ti-hanger','fashion',11,
          {variants:[sizes(['S','M','L','XL']),colors([{v:'black',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'navy',ar:'كحلي',en:'Navy',hex:'#1B2A4A'},{v:'olive',ar:'زيتي',en:'Olive',hex:'#5B6236'}])],
           desc:{ar:'جاكيت خفيف مبطّن يوفر دفئاً عالياً بمظهر أنيق.',en:'Lightweight padded jacket offering high warmth with a sharp look.'}}),
        P('CM-11','قميص لينن بريميوم','Premium Linen Shirt','18.000','',0,'4.7','86','ti-shirt','fashion',12,{variants:[sizes(['S','M','L','XL'])]}),
        P('CM-12','بنطلون كاجوال واسع','Wide-Leg Casual Trousers','18.700','22.000',15,'4.9','73','ti-hanger','fashion',9,{variants:[sizes(['S','M','L','XL'])]}),
        P('CM-13','هودي أوفرسايز فاخر','Luxe Oversize Hoodie','25.000','',0,'4.6','58','ti-shirt','fashion',6,{variants:[sizes(['S','M','L','XL'])]}),
        P('CM-14','تيشيرت بيسك كلاسيك','Classic Basic Tee','8.500','',0,'4.8','201','ti-shirt','fashion',22,{variants:[sizes(['S','M','L','XL']),C_BWN]}),
        P('CM-15','قميص بولو فاخر','Premium Polo Shirt','21.600','24.000',10,'4.7','64','ti-shirt','fashion',0,{variants:[sizes(['S','M','L','XL'])]}),
        P('CM-16','بنطلون جينز سليم','Slim Fit Jeans','23.000','',0,'4.5','41','ti-hanger','fashion',14,{variants:[sizes(['30','32','34','36'])]}),
        P('CM-17','فستان صيفي مطبوع','Printed Summer Dress','26.500','34.000',22,'4.8','92','ti-hanger','fashion',8,{variants:[sizes(['S','M','L'])]}),
        P('CM-18','سويتشيرت قطن عضوي','Organic Cotton Sweatshirt','19.900','',0,'4.4','37','ti-shirt','fashion',10,{variants:[sizes(['S','M','L','XL'])]})
      ]},

    { slug:'techzone', name:{ar:'تك هاوس',en:'TechZone'}, num:'#003', ic:'ti-device-mobile',
      cover:'', cat:{ar:'هواتف وإلكترونيات',en:'Phones & Electronics'}, rating:'4.8', orders:'2,140',
      followers:'5.8K', productCount:312, satisfaction:'97%', reviewCount:317, reviewScore:'4.8',
      status:STORE_STATUS.OPEN, sponsored:true,
      hours:{ ar:'يومياً: 10ص – 11م', en:'Daily: 10am – 11pm' },
      desc:{ar:'TechZone — وجهتك الأولى للهواتف والأجهزة الإلكترونية في الكويت. أجهزة أصلية بضمان رسمي وأفضل الأسعار.',
             en:'TechZone — your first destination for phones and electronics in Kuwait. Genuine devices with official warranty at the best prices.'},
      cats:['electronics','accessories'],
      items:[
        P('P-003','iPhone 16 Pro','iPhone 16 Pro','189.000','220.000',15,'5.0','210','ti-device-mobile','electronics',6,
          {variants:[{label:{ar:'السعة',en:'Storage'},options:[{v:'128',label:{ar:'128GB',en:'128GB'}},{v:'256',label:{ar:'256GB',en:'256GB'}},{v:'512',label:{ar:'512GB',en:'512GB'}}]},
                     colors([{v:'ti',ar:'تيتانيوم',en:'Titanium',hex:'#8E8E93'},{v:'bk',ar:'أسود',en:'Black',hex:'#1A1A1A'},{v:'wt',ar:'أبيض',en:'White',hex:'#F2F0EA'}])],
           desc:{ar:'أداء فائق وكاميرا احترافية بضمان رسمي.',en:'Flagship performance and a pro camera, with official warranty.'}}),
        P('P-EARBUDS','سماعات لاسلكية فاخرة','Premium Wireless Earbuds','24.500','35.000',30,'4.8','320','ti-device-mobile','electronics',14,
          {desc:{ar:'صوت نقي وعزل ضوضاء نشط مع علبة شحن سريعة.',en:'Crisp sound with active noise cancelling and fast-charge case.'}}),
        P('P-HEADPHONES','سماعة رأس احترافية','Pro Headphones','38.000','52.000',27,'4.8','410','ti-headphones','electronics',0,
          {variants:[C_BW,{label:{ar:'السعة',en:'Storage'},options:[{v:'std',label:{ar:'قياسي',en:'Standard'}},{v:'plus',label:{ar:'بلس (ذاكرة)',en:'Plus (memory)'}}]}],
           desc:{ar:'سماعة احترافية بعزل ضوضاء وبطارية تدوم 40 ساعة.',en:'Studio-grade headphones with ANC and 40-hour battery.'}}),
        P('P-008','سماعة Sony WH-1000XM5','Sony WH-1000XM5','35.750','55.000',35,'4.9','201','ti-headphones','electronics',5,{variants:[C_BS]}),
        P('TZ-11','تابلت 11 بوصة','11-inch Tablet','135.000','',0,'4.6','88','ti-device-tablet','electronics',9),
        P('TZ-12','شاحن سريع 65 واط','65W Fast Charger','12.500','18.000',30,'4.7','156','ti-plug','accessories',32),
        P('TZ-13','باور بانك 20000 مللي','20,000mAh Power Bank','16.900','',0,'4.5','104','ti-battery-3','accessories',21),
        P('TZ-14','هاتف ذكي متوسط الفئة','Mid-Range Smartphone','78.000','95.000',18,'4.4','67','ti-device-mobile','electronics',12),
        P('TZ-15','ساعة ذكية رياضية','Sport Smartwatch','42.000','',0,'4.6','93','ti-watch','watches',8),
        P('TZ-16','مكبر صوت بلوتوث','Bluetooth Speaker','19.500','26.000',25,'4.7','128','ti-device-speaker','electronics',0),
        P('TZ-17','تابلت للأطفال 8 بوصة',"8-inch Kids' Tablet",'52.000','',0,'4.3','45','ti-device-tablet','electronics',15),
        P('TZ-18','حافظة هاتف مضادة للصدمات','Rugged Phone Case','5.900','8.500',31,'4.5','187','ti-device-mobile','accessories',44)
      ]},

    { slug:'sole-co', name:{ar:'سول آند كو',en:'Sole & Co'}, num:'#002', ic:'ti-shoe',
      cover:'', cat:{ar:'أحذية ورياضة',en:'Footwear & Sport'}, rating:'4.7', orders:'892',
      followers:'2.1K', productCount:156, satisfaction:'95%', reviewCount:94, reviewScore:'4.7',
      status:STORE_STATUS.OPEN, sponsored:false,
      hours:{ ar:'يومياً: 10ص – 10م', en:'Daily: 10am – 10pm' },
      desc:{ar:'متجر Sole & Co للأحذية الرياضية والكاجوال — أفضل ماركات الأحذية العالمية والمحلية في الكويت بأسعار تنافسية.',
             en:'Sole & Co for sport and casual footwear — the best global and local shoe brands in Kuwait at competitive prices.'},
      cats:['shoes'],
      items:[
        P('P-002','حذاء رياضي Air Comfort','Air Comfort Sneakers','28.500','38.000',25,'4.7','89','ti-shoe','shoes',9,
          {variants:[sizes([40,41,42,43,44])], desc:{ar:'نعل مريح خفيف الوزن مناسب للاستخدام اليومي.',en:'Lightweight cushioned sole built for all-day wear.'}}),
        P('SC-11','حذاء جري خفيف','Lightweight Running Shoes','32.000','',0,'4.6','54','ti-shoe','shoes',11,{variants:[sizes([40,41,42,43,44])]}),
        P('SC-12','حذاء كاجوال جلد','Leather Casual Shoes','26.000','34.000',23,'4.8','77','ti-shoe','shoes',7,{variants:[sizes([40,41,42,43,44])]}),
        P('SC-13','حذاء رسمي أوكسفورد','Oxford Formal Shoes','45.000','',0,'4.9','38','ti-shoe','shoes',5,{variants:[sizes([40,41,42,43,44])]}),
        P('SC-14','حذاء تدريب متعدد','Cross Training Shoes','35.500','42.000',15,'4.5','62','ti-shoe','shoes',0,{variants:[sizes([40,41,42,43,44])]}),
        P('SC-15','سنيكرز كلاسيك أبيض','Classic White Sneakers','22.900','',0,'4.7','145','ti-shoe','shoes',18,{variants:[sizes([40,41,42,43,44])]}),
        P('SC-16','حذاء لوفر جلد سويدي','Suede Leather Loafers','38.000','48.000',21,'4.6','29','ti-shoe','shoes',6,{variants:[sizes([40,41,42,43,44])]}),
        P('SC-17','شبشب رياضي مريح','Comfort Sport Slides','9.500','',0,'4.4','96','ti-shoe','shoes',25,{variants:[sizes([40,41,42,43,44])]})
      ]},

    { slug:'luxe-accessories', name:{ar:'لوكس إكسسوارز',en:'Luxe Accessories'}, num:'#004', ic:'ti-sunglasses',
      cover:'', cat:{ar:'اكسسوارات فاخرة',en:'Luxury Accessories'}, rating:'4.6', orders:'648',
      followers:'1.4K', productCount:98, satisfaction:'93%', reviewCount:62, reviewScore:'4.6',
      status:STORE_STATUS.OPEN, sponsored:false,
      hours:{ ar:'يومياً: 11ص – 10م', en:'Daily: 11am – 10pm' },
      desc:{ar:'Luxe Accessories — اكسسوارات فاخرة من أفضل الماركات العالمية. نظارات، حقائب، وساعات بتصاميم راقية.',
             en:'Luxe Accessories — refined pieces from the finest global brands. Eyewear, bags and watches with elegant design.'},
      cats:['accessories','bags','watches'],
      items:[
        P('P-004','نظارة شمسية Ray Luxe','Ray Luxe Sunglasses','35.000','58.000',40,'4.6','67','ti-sunglasses','accessories',12,
          {desc:{ar:'عدسات مستقطبة بحماية كاملة من الأشعة.',en:'Polarised lenses with full UV protection.'}}),
        P('LX-11','نظارة طبية إطار معدني','Metal Frame Eyeglasses','28.000','',0,'4.4','31','ti-sunglasses','accessories',9),
        P('LX-12','حقيبة كتف جلد فاخر','Luxury Leather Shoulder Bag','62.000','78.000',20,'4.8','54','ti-backpack','bags',5,{variants:[C_BRB]}),
        P('LX-13','محفظة جلد كلاسيكية','Classic Leather Wallet','18.500','',0,'4.7','88','ti-wallet','bags',17,{variants:[C_BRB]}),
        P('LX-14','ساعة يد بتصميم مينيمال','Minimalist Wristwatch','54.000','70.000',23,'4.5','42','ti-clock-hour-4','watches',0,{variants:[C_BS]}),
        P('LX-15','حزام جلد طبيعي','Genuine Leather Belt','14.900','',0,'4.6','73','ti-hanger','accessories',20,{variants:[C_BRB]}),
        P('LX-16','نظارة شمسية بولارايزد','Polarised Sunglasses','41.000','52.000',21,'4.7','59','ti-sunglasses','accessories',7),
        P('LX-17','ساعة جلد كلاسيكية','Classic Leather Watch','68.000','85.000',20,'4.9','96','ti-clock-hour-4','watches',4,{variants:[C_BRB]})
      ]},

    { slug:'urban-thread', name:{ar:'أوربان ثريد',en:'Urban Thread'}, num:'#005', ic:'ti-shirt',
      cover:'', cat:{ar:'ملابس كاجوال',en:'Casual Wear'}, rating:'4.5', orders:'420',
      followers:'980', productCount:74, satisfaction:'90%', reviewCount:48, reviewScore:'4.5',
      status:STORE_STATUS.CLOSED, sponsored:false,
      hours:{ ar:'يومياً: 12م – 10م', en:'Daily: 12pm – 10pm' },
      desc:{ar:'Urban Thread — ملابس كاجوال عصرية للشباب. أسلوب حياة مريح ومعاصر بأسعار في متناول الجميع.',
             en:'Urban Thread — modern casual wear for a younger crowd. Comfortable, contemporary style at accessible prices.'},
      cats:['fashion'],
      items:[
        P('UT-11','تيشيرت جرافيك مطبوع','Graphic Print Tee','9.900','14.000',29,'4.5','112','ti-shirt','fashion',26,{variants:[sizes(['S','M','L','XL'])]}),
        P('UT-12','تيشيرت قطن أساسي','Essential Cotton Tee','7.500','',0,'4.6','204','ti-shirt','fashion',38,{variants:[sizes(['S','M','L','XL'])]}),
        P('UT-13','سويتشيرت بغطاء رأس','Hooded Sweatshirt','21.000','28.000',25,'4.4','67','ti-shirt','fashion',14,{variants:[sizes(['S','M','L','XL'])]}),
        P('UT-14','شورت رياضي كوول','Cool Sport Shorts','14.000','',0,'4.5','58','ti-hanger','fashion',19,{variants:[sizes(['S','M','L','XL'])]}),
        P('UT-15','سويتشيرت كروبد','Cropped Sweatshirt','18.500','24.000',23,'4.3','34','ti-shirt','fashion',0,{variants:[sizes(['S','M','L'])]}),
        P('UT-16','شورت جينز كاجوال','Casual Denim Shorts','16.900','',0,'4.2','41','ti-hanger','fashion',11,{variants:[sizes(['S','M','L','XL'])]}),
        P('UT-17','تيشيرت أوفرسايز','Oversized Tee','11.500','15.000',23,'4.7','89','ti-shirt','fashion',23,{variants:[sizes(['S','M','L','XL'])]}),
        P('UT-18','جاكيت جينز خفيف','Light Denim Jacket','32.000','',0,'4.6','52','ti-hanger','fashion',8,{variants:[sizes(['S','M','L','XL'])]})
      ]},

    { slug:'glam-store', name:{ar:'جلام ستور',en:'Glam Store'}, num:'#006', ic:'ti-diamond',
      cover:'', cat:{ar:'اكسسوارات وساعات',en:'Accessories & Watches'}, rating:'4.9', orders:'1,052',
      followers:'2.9K', productCount:167, satisfaction:'99%', reviewCount:204, reviewScore:'4.9',
      status:STORE_STATUS.OPEN, sponsored:false,
      hours:{ ar:'يومياً: 10ص – 11م', en:'Daily: 10am – 11pm' },
      desc:{ar:'Glam Store — اكسسوارات فاخرة وساعات ذكية بريميوم. لأن التفاصيل هي ما يصنع الفارق في إطلالتك.',
             en:'Glam Store — luxury accessories and premium smartwatches. Because the details are what set your look apart.'},
      cats:['watches','jewelry','accessories'],
      items:[
        P('P-006','ساعة ذكية Premium','Premium Smartwatch','75.000','94.000',20,'4.8','98','ti-watch','watches',10,
          {variants:[C_BS], desc:{ar:'تتبع صحي متكامل وشاشة AMOLED دائمة العمل.',en:'Full health tracking with an always-on AMOLED display.'}}),
        P('GS-11','خاتم فضة مرصّع','Studded Silver Ring','33.000','45.000',27,'4.9','76','ti-diamond','jewelry',12,{variants:[sizes(['16','17','18','19'])]}),
        P('GS-12','سوار ذهبي رفيع','Fine Gold Bracelet','58.000','72.000',19,'4.9','54','ti-diamond','jewelry',6),
        P('GS-13','ساعة ذكية نسائية',"Women's Smartwatch",'62.000','',0,'4.7','83','ti-watch','watches',9,{variants:[C_BS]}),
        P('GS-14','قلادة لؤلؤ كلاسيكية','Classic Pearl Necklace','44.500','56.000',21,'4.8','47','ti-diamond','jewelry',0),
        P('GS-15','حزام ساعة جلد بديل','Spare Leather Watch Strap','11.000','',0,'4.5','121','ti-clock-hour-4','accessories',34,{variants:[C_BRB]}),
        P('GS-16','أقراط ذهبية صغيرة','Petite Gold Earrings','27.500','35.000',21,'4.8','92','ti-diamond','jewelry',15),
        P('GS-17','علبة مجوهرات فاخرة','Luxury Jewellery Box','19.900','',0,'4.6','38','ti-box','accessories',13)
      ]},

    { slug:'dar-aloud', name:{ar:'دار العود',en:'Dar Aloud'}, num:'#007', ic:'ti-spray',
      cover:'', cat:{ar:'عطور',en:'Perfume'}, rating:'4.9', orders:'760',
      followers:'1.8K', productCount:64, satisfaction:'96%', reviewCount:98, reviewScore:'4.9',
      status:STORE_STATUS.OPEN, sponsored:false,
      hours:{ ar:'يومياً: 10ص – 11م', en:'Daily: 10am – 11pm' },
      desc:{ar:'دار العود — عطور شرقية فاخرة وعود أصلي بخلطات تدوم طويلاً.',
             en:'Dar Aloud — luxury oriental perfumes and genuine oud with long-lasting blends.'},
      cats:['perfume'],
      items:[
        P('P-PERFUME','عطر شرقي فاخر','Luxury Oriental Perfume','42.000','60.000',30,'4.9','215','ti-spray','perfume',8,
          {variants:[{label:{ar:'الحجم',en:'Size'},options:[{v:'50',label:{ar:'50 مل',en:'50 ml'}},{v:'100',label:{ar:'100 مل',en:'100 ml'}},{v:'150',label:{ar:'150 مل',en:'150 ml'}}]}],
           desc:{ar:'مزيج شرقي فاخر من العود والمسك يدوم طويلاً.',en:'A rich oriental blend of oud and musk with long-lasting sillage.'}}),
        P('DA-11','عطر عود ملكي','Royal Oud Perfume','68.000','85.000',20,'4.8','76','ti-spray','perfume',6,
          {variants:[{label:{ar:'الحجم',en:'Size'},options:[{v:'50',label:{ar:'50 مل',en:'50 ml'}},{v:'100',label:{ar:'100 مل',en:'100 ml'}}]}]}),
        P('DA-12','مبخرة عود فاخرة','Premium Oud Incense','24.000','',0,'4.7','54','ti-flame','perfume',14),
        P('DA-13','عطر مسك أبيض','White Musk Perfume','29.500','38.000',22,'4.6','89','ti-spray','perfume',11)
      ]},

    { slug:'time-box', name:{ar:'تايم بوكس',en:'Time Box'}, num:'#008', ic:'ti-clock-hour-4',
      cover:'', cat:{ar:'ساعات',en:'Watches'}, rating:'4.7', orders:'540',
      followers:'1.1K', productCount:48, satisfaction:'94%', reviewCount:72, reviewScore:'4.7',
      status:STORE_STATUS.OPEN, sponsored:false,
      hours:{ ar:'يومياً: 10ص – 10م', en:'Daily: 10am – 10pm' },
      desc:{ar:'تايم بوكس — ساعات كلاسيكية وعصرية بضمان رسمي وتشكيلة واسعة.',
             en:'Time Box — classic and modern watches with official warranty and a wide selection.'},
      cats:['watches'],
      items:[
        P('P-WATCH','ساعة كلاسيكية جلد','Classic Leather Watch','68.000','85.000',20,'4.7','142','ti-clock-hour-4','watches',5,
          {variants:[colors([{v:'brown',ar:'جلد بني',en:'Brown Leather',hex:'#8B5A2B'},{v:'black',ar:'جلد أسود',en:'Black Leather',hex:'#1A1A1A'}])],
           desc:{ar:'تصميم كلاسيكي بسوار جلد طبيعي وحركة دقيقة.',en:'Classic design with a genuine leather strap and precise movement.'}}),
        P('TB-11','ساعة كرونوغراف رياضية','Sport Chronograph Watch','92.000','120.000',23,'4.8','63','ti-clock-hour-4','watches',4,{variants:[C_BS]}),
        P('TB-12','ساعة ستانلس ستيل','Stainless Steel Watch','76.000','',0,'4.6','48','ti-clock-hour-4','watches',7,{variants:[C_BS]})
      ]}
  ];

  /* ---------- flatten ---------- */
  var STORES = [], PRODUCTS = [], BY_ID = {}, BY_SLUG = {};
  RAW.forEach(function (s) {
    var store = {
      slug:s.slug, name:s.name, num:s.num, ic:s.ic, cover:s.cover, cat:s.cat,
      rating:s.rating, orders:s.orders, followers:s.followers, productCount:s.productCount,
      satisfaction:s.satisfaction, reviewCount:s.reviewCount, reviewScore:s.reviewScore,
      status:s.status, sponsored:!!s.sponsored, hours:s.hours, desc:s.desc, cats:s.cats || []
    };
    STORES.push(store); BY_SLUG[s.slug] = store;
    (s.items || []).forEach(function (p) {
      p.store = s.slug;
      PRODUCTS.push(p); BY_ID[p.id] = p;
    });
  });

  /* ---------- runtime overrides (what makes edits appear everywhere) ---------- */
  function readOverrides(){
    try { var o = JSON.parse(localStorage.getItem(LS_OVERRIDES)); return (o && typeof o === 'object') ? o : { products:{}, stores:{} }; }
    catch(e){ return { products:{}, stores:{} }; }
  }
  function writeOverrides(o){
    try { localStorage.setItem(LS_OVERRIDES, JSON.stringify(o)); } catch(e){}
    document.dispatchEvent(new CustomEvent('raf:source'));
  }
  function merge(base, patch){
    if (!patch) return base;
    var out = {}; for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
    for (var j in patch) if (patch.hasOwnProperty(j)) out[j] = patch[j];
    return out;
  }

  /* ---------- reads (base + overrides) ---------- */
  function store(slug){
    var b = BY_SLUG[slug]; if (!b) return null;
    return merge(b, readOverrides().stores[slug]);
  }
  function product(id){
    var b = BY_ID[id]; if (!b) return null;
    var p = merge(b, readOverrides().products[id]);
    p.storeRef = store(p.store);
    return p;
  }
  function stores(opts){
    opts = opts || {};
    var ov = readOverrides().stores;
    var list = STORES.map(function(s){ return merge(s, ov[s.slug]); })
      .filter(function(s){ return s.status !== STORE_STATUS.DELETED; });
    if (opts.visibleOnly !== false) list = list.filter(function(s){ return s.status === STORE_STATUS.OPEN; });
    /* sponsored stores rank first — visibility is a paid, clearly-badged option */
    return list.sort(function(a,b){ return (b.sponsored?1:0) - (a.sponsored?1:0); });
  }
  /* a product is listable only when it is active AND its store is open */
  function isVisible(p){
    if (!p || p.status !== PRODUCT_STATUS.ACTIVE) return false;
    var s = store(p.store);
    return !!s && s.status === STORE_STATUS.OPEN;
  }
  function products(opts){
    opts = opts || {};
    var ov = readOverrides().products;
    var list = PRODUCTS.map(function(p){ return merge(p, ov[p.id]); });
    if (opts.visibleOnly !== false) list = list.filter(isVisible);
    if (opts.cat) list = list.filter(function(p){ return p.cat === opts.cat; });
    if (opts.store) list = list.filter(function(p){ return p.store === opts.store; });
    if (opts.onSale) list = list.filter(function(p){ return (p.disc || 0) > 0; });
    if (opts.inStock) list = list.filter(function(p){ return p.stock !== 0; });
    return list.sort(function(a,b){ return (b.sponsored?1:0) - (a.sponsored?1:0); });
  }
  function categories(opts){
    opts = opts || {};
    var cats = CATEGORIES.slice().sort(function(a,b){ return a.sort - b.sort; });
    if (opts.populatedOnly === false) return cats;
    /* only surface categories that actually have visible products */
    var live = {};
    products({}).forEach(function(p){ live[p.cat] = 1; });
    return cats.filter(function(c){ return live[c.k]; });
  }

  /* ---------- writes (admin / merchant surface, foundation for sync) ---------- */
  function updateProduct(id, patch){
    if (!BY_ID[id]) return false;
    var o = readOverrides(); o.products[id] = merge(o.products[id] || {}, patch); writeOverrides(o); return true;
  }
  function updateStore(slug, patch){
    if (!BY_SLUG[slug]) return false;
    var o = readOverrides(); o.stores[slug] = merge(o.stores[slug] || {}, patch); writeOverrides(o); return true;
  }
  function resetOverrides(){ try { localStorage.removeItem(LS_OVERRIDES); } catch(e){} document.dispatchEvent(new CustomEvent('raf:source')); }

  /* store display name in the active language — used by legacy shapes */
  function lang(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en' ? 'en' : 'ar'; }

  global.RAFSource = {
    STORE_STATUS:STORE_STATUS, PRODUCT_STATUS:PRODUCT_STATUS,
    product:product, products:products, store:store, stores:stores,
    categories:categories, isVisible:isVisible,
    updateProduct:updateProduct, updateStore:updateStore, resetOverrides:resetOverrides,
    /* raw accessors for adapters/tests */
    all:function(){ return products({ visibleOnly:false }); },
    allStores:function(){ return stores({ visibleOnly:false }); },
    lang:lang
  };

  /* keep every open page in sync when another tab edits the source */
  window.addEventListener('storage', function(e){
    if (e.key === LS_OVERRIDES) document.dispatchEvent(new CustomEvent('raf:source'));
  });
})(window);
