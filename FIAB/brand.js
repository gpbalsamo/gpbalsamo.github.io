// ECMWF and Destination Earth branding of the FIAB pages (gpbalsamo.github.io/FIAB). Logos from the
// Forecast-in-a-Box repository (frontend/public/logos), served from FIAB/img/brand/.
// <script src="../brand.js" data-pos="bl|br|tl|tr|tc|bc" defer></script>  a small fixed badge in that corner
// <script src="brand.js" data-mode="footer" data-into="#brand" defer></script>  a band with the statement (landing page)
// data-into=<selector> without data-mode: the badge inline at the end of that element (data-first: at its start).
(() => {
  const me = document.currentScript, root = new URL("./", me.src).href, img = root + "img/brand/";
  const mode = me.dataset.mode || "badge", pos = me.dataset.pos || "bl", into = me.dataset.into, first = "first" in me.dataset;
  const TEXT = "Forecast-in-a-Box is a prototype AI solution concept piloted by ECMWF, through an effort jointly " +
    "funded by Destination Earth and ECMWF core activities. These pages are experimental research demonstrations, " +
    "not official forecasts or warnings.";
  const css = `
.fiab-brand{display:inline-flex;align-items:center;gap:12px;background:#0e1f44;border:1px solid #ffffff26;border-radius:8px;
 padding:5px 10px;box-shadow:0 4px 16px #0005;font:11px/1.2 system-ui,sans-serif;color:#fff;z-index:50}
.fiab-brand a{display:inline-flex;align-items:center;gap:6px;opacity:.92}.fiab-brand a:hover{opacity:1}
.fiab-brand img{display:block;width:auto}.fiab-brand .e{height:17px}.fiab-brand .f{height:19px}.fiab-brand .d{height:10px}
.fiab-brand.fx{position:fixed}.fiab-brand.p-bl{left:12px;bottom:12px}.fiab-brand.p-br{right:12px;bottom:12px}
.fiab-brand.p-tl{left:12px;top:12px}.fiab-brand.p-tr{right:12px;top:12px}
.fiab-brand.p-tc{left:50%;top:10px;transform:translateX(-50%)}.fiab-brand.p-bc{left:50%;bottom:10px;transform:translateX(-50%)}
.fiab-band{background:#0e1f44;color:#ffffffcc;padding:22px 20px;margin-top:28px;border-radius:12px;text-align:center;font:13px/1.5 system-ui,sans-serif}
.fiab-band .logos{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:20px 56px;margin-bottom:14px}
.fiab-band a{display:inline-flex;align-items:center;gap:10px}.fiab-band img{display:block;width:auto}
.fiab-band .e{height:32px}.fiab-band .f{height:34px}.fiab-band .d{height:19px}.fiab-band p{margin:4px auto;max-width:820px}
.fiab-band p a{display:inline;color:#9fd0f0}
@media print{.fiab-brand.fx{position:static}}
.fiab-brand.in{margin-left:auto}.fiab-brand.first{margin:0 0 18px}`
    + (pos === "tc" && !into ? "\n#status{top:60px!important}" : "");
  const logos = `<a href="https://www.ecmwf.int/" target="_blank" rel="noopener" title="ECMWF"><img class="e" src="${img}ecmwf.svg" alt="ECMWF"></a>` +
    `<a href="https://destination-earth.eu/" target="_blank" rel="noopener" title="Destination Earth, funded by the European Union">` +
    `<img class="f" src="${img}eu-flag.svg" alt="European Union"><img class="d" src="${img}destine-wordmark-dark.svg" alt="Destination Earth"></a>`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const el = document.createElement("div");
  if (mode === "footer") {
    el.className = "fiab-band";
    el.innerHTML = `<div class="logos">${logos}</div><p>Forecast-in-a-Box is a prototype AI solution concept piloted by ECMWF, ` +
      `through an effort jointly funded by <a href="https://destination-earth.eu/" target="_blank" rel="noopener">Destination Earth</a> ` +
      `and ECMWF core activities. These pages are experimental research demonstrations, not official forecasts or warnings.</p>` +
      `<p>© European Centre for Medium-Range Weather Forecasts</p>`;
  } else {
    el.className = "fiab-brand" + (into ? (first ? " first" : " in") : ` fx p-${pos}`); el.title = TEXT; el.setAttribute("role", "contentinfo");
    el.innerHTML = logos;
  }
  const put = () => { const t = into && document.querySelector(into) || document.body; first ? t.prepend(el) : t.appendChild(el); };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", put) : put();
})();
