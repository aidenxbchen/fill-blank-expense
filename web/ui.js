/* Presentation-only feedback. No network, storage, credentials or business rules. */
(function (root) {
  "use strict";
  const locked = new WeakSet();
  async function run(button, action, label, peers = []) {
    if (locked.has(button)) return;
    locked.add(button);
    const text = button.textContent;
    const controls = [...new Set([button, ...peers])];
    const previous = controls.map(el => el.disabled);
    controls.forEach(el => { el.disabled = true; });
    button.setAttribute("aria-busy", "true");
    button.textContent = label;
    try { return await action(); }
    finally {
      controls.forEach((el, i) => { el.disabled = previous[i]; });
      button.textContent = text;
      button.removeAttribute("aria-busy");
      locked.delete(button);
    }
  }

  function bindDialogs(doc) {
    let active = null, origin = null, background = [];
    const focusable = modal => [...modal.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex="0"]')]
      .filter(el => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
    function sync() {
      const next = [...doc.querySelectorAll('.modal-backdrop')].find(el => !el.hidden) || null;
      if (next === active) return;
      if (active) {
        background.forEach(([el, value]) => { el.inert = value; });
        doc.body.classList.remove("has-modal");
        if (origin && origin.isConnected && !origin.closest("[hidden]")) origin.focus({preventScroll:true});
      }
      active = next;
      if (!active) return;
      const menu = doc.querySelector(".workspace-menu");
      if (menu) menu.open = false;
      origin = doc.activeElement;
      background = [...doc.querySelectorAll('body > header, body > nav, body > main, body > .save-strip')].map(el => [el, el.inert]);
      background.forEach(([el]) => { el.inert = true; });
      doc.body.classList.add("has-modal");
      active.tabIndex = -1;
      (focusable(active)[0] || active).focus({preventScroll:true});
    }
    const observer = new MutationObserver(sync);
    observer.observe(doc.body, {subtree:true, attributes:true, attributeFilter:["hidden"]});
    doc.addEventListener("keydown", event => {
      if (!active) {
        if (event.key === "Escape") doc.querySelectorAll(".workspace-menu[open]").forEach(el => { el.open=false;el.querySelector("summary").focus(); });
        return;
      }
      if (event.key === "Escape") { event.preventDefault();active.hidden = true;sync();return; }
      if (event.key !== "Tab") return;
      const items=focusable(active), first=items[0], last=items[items.length-1];
      if (!first) { event.preventDefault();active.focus(); }
      else if (event.shiftKey && (doc.activeElement === first || !active.contains(doc.activeElement))) {event.preventDefault();last.focus();}
      else if (!event.shiftKey && (doc.activeElement === last || !active.contains(doc.activeElement))) {event.preventDefault();first.focus();}
    });
    doc.addEventListener("focusin", () => {
      if (active && !active.contains(doc.activeElement)) (focusable(active)[0] || active).focus({preventScroll:true});
    });
    doc.addEventListener("click", event => {
      const menu=doc.querySelector(".workspace-menu");
      if (menu && (!menu.contains(event.target) || event.target.closest("button, a"))) menu.open=false;
    });
    sync();
    return () => observer.disconnect();
  }

  const api = {run, bindDialogs};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ExpenseUI = api;
})(typeof window !== "undefined" ? window : globalThis);

/* Blessing card shuffle */
(function () {
  const card = document.getElementById('blessing-card');
  const btn = document.getElementById('btn-blessing-shuffle');
  const zh = document.getElementById('blessing-zh');
  const en = document.getElementById('blessing-en');
  const note = document.getElementById('blessing-note');
  if (!card || !btn || !zh || !en || !note) return;
  const lines = [
    { zh: '流星发生时', en: 'When meteors write across the sky', note: '愿这一单也顺利如愿' },
    { zh: '归来如初', en: 'Return as we first met', note: '把心事安稳地放回口袋' },
    { zh: '山河远阔', en: 'Mountains wide, rivers long', note: '你要的答案会按时抵达' },
    { zh: '星河入梦', en: 'A river of stars into dreams', note: '今晚的账，也温柔结清' },
    { zh: '一纸清欢', en: 'A quiet joy on paper', note: '报销烦心事，留给报了么' },
    { zh: '月色正好', en: 'The moonlight is just right', note: '慢慢填，也不晚' },
    { zh: '万事顺意', en: 'May all go as you wish', note: '点一点，世界轻一点' },
    { zh: '花开有时', en: 'Flowers bloom in their season', note: '这笔费用，终会安放妥当' }
  ];
  let i = Math.floor(Math.random() * lines.length);
  const paint = () => {
    const L = lines[i % lines.length];
    card.classList.remove('is-shuffling');
    void card.offsetWidth;
    card.classList.add('is-shuffling');
    zh.textContent = L.zh;
    en.textContent = L.en;
    note.textContent = L.note;
    card.dataset.index = String(i % lines.length);
  };
  paint();
  const next = () => { i = (i + 1) % lines.length; paint(); };
  btn.addEventListener('click', next);
  card.addEventListener('dblclick', next);
})();
