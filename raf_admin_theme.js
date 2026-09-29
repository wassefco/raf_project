/* RAF Management — theme before first paint, so a dark-mode viewer never sees a
   light flash. Reading the saved preference writes nothing. Load in <head>. */
(function(){
  var t = null; try { t = localStorage.getItem('raf_admin_theme'); } catch(e){}
  if(t !== 'light' && t !== 'dark'){
    t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
