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
      background = [...doc.querySelectorAll('body > header, body > nav, body > main, body > #astryx-root, body > .save-strip')].map(el => [el, el.inert]);
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

  const needsAiSetup = data => !Boolean(data && data.configured && data.settings && data.settings.hasApiKey);
  const api = {run, bindDialogs, needsAiSetup};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ExpenseUI = api;
})(typeof window !== "undefined" ? window : globalThis);

/* Blessing card shuffle */
(function () {
  if (typeof document === "undefined") return;
  const card = document.getElementById('blessing-card');
  const btn = document.getElementById('btn-blessing-shuffle');
  const zh = document.getElementById('blessing-zh');
  const en = document.getElementById('blessing-en');
  const note = document.getElementById('blessing-note');
  const counter = document.getElementById('blessing-counter');
  if (!card || !btn || !zh || !en || !note) return;
  const lines = [
    { no: '01', title: '先迈一步', quote: '不用等“完全准备好”\n先迈出这一步\n路会在脚下慢慢长出来', note: 'Start before you feel ready.' },
    { no: '02', title: '旷野与风', quote: '人生不是单行轨道\n你可以按自己的节奏\n穿过旷野，也吹吹风', note: 'Your pace is the right pace.' },
    { no: '03', title: '留白呼吸', quote: '不必把每一格都填满\n留一点空隙给阳光\n心才会跟着松快下来', note: 'Leave a little room to breathe.' },
    { no: '04', title: '安顿琐碎', quote: '把零散的票据收好\n也把今天的小烦恼\n一并归档，轻装往前', note: 'Small things settled, mind cleared.' },
    { no: '05', title: '慢慢发光', quote: '不急着立刻被看见\n认真走过的每一步\n都在替你积攒底气', note: 'Quiet effort builds steady ground.' },
    { no: '06', title: '允许暂停', quote: '累的时候就停一停\n喝口热茶再继续\n休息也是赶路的一部分', note: 'Pausing is part of the journey.' },
    { no: '07', title: '各自花期', quote: '不用羡慕别人的快\n每朵花都有自己的节气\n你只管安心生长', note: 'Every season unfolds in its own time.' },
    { no: '08', title: '温柔落地', quote: '愿你手头繁琐的事\n都能一件件顺手理清\n今晚安心早点回家', note: 'May today wrap up gently.' },
    { no: '09', title: '小小确幸', quote: '生活不靠惊天动地\n往往藏在一笔核对无误\n和窗外刚好的微风里', note: 'Joy lives in small, neat moments.' },
    { no: '10', title: '保持好奇', quote: '熟悉的事情做久了\n也别忘了留一点意外\n像第一次看见世界那样', note: 'A familiar form, a fresh perspective.' },
    { no: '11', title: '轻装上阵', quote: '昨天已经翻篇了\n今天只带好心情\n和一点点笃定出发', note: 'Travel light into today.' },
    { no: '12', title: '诚实对待', quote: '不必讨好所有标准\n只要对得起自己的认真\n就已经是很好的答案', note: 'Sincere work is its own reward.' },
    { no: '13', title: '细水长流', quote: '真正稳妥的节奏\n不是一阵子拼命冲刺\n而是每天都能从容一点', note: 'Steady steps go the furthest.' },
    { no: '14', title: '清醒且暖', quote: '保持边界与秩序\n也保留心底的温度\n理性也可以很温柔', note: 'Clear in structure, warm at heart.' },
    { no: '15', title: '准时抵达', quote: '别怕眼前的路绕远\n只要方向没有偏\n你要的答案会准时来', note: 'What is meant for you will arrive.' },
    { no: '16', title: '刚刚好', quote: '不必苛求万无一失\n做到此刻能做的最好\n剩下的交给时间', note: 'Good enough today is plenty.' },
    { no: '17', title: '看见自己', quote: '忙着处理别人的事时\n别忘了问问自己\n今天过得还开心吗', note: 'Check in with yourself today.' },
    { no: '18', title: '微光成炬', quote: '那些看似不起眼的坚持\n会在某个转角突然连成线\n照亮你接下去的路', note: 'Little sparks connect into light.' },
    { no: '19', title: '自洽从容', quote: '不和别人的时间表较劲\n守住自己的步频\n安静地把事做成', note: 'Move at your own calm rhythm.' },
    { no: '20', title: '云散见月', quote: '偶尔卡住也没关系\n换个角度再看一眼\n办法总比困惑多一点', note: 'A new angle opens the way.' },
    { no: '21', title: '收放自如', quote: '工作时专注投入\n下班后彻底松弛\n把生活还给自己', note: 'Focus deeply, then rest fully.' },
    { no: '22', title: '善待日常', quote: '认真吃一顿热饭\n认真走好每段通勤\n平凡日子也会闪闪发亮', note: 'Ordinary days hold quiet gold.' },
    { no: '23', title: '笃定前行', quote: '外面的声音再嘈杂\n心里有数的人\n脚步永远不会乱', note: 'Calm certainty outlasts the noise.' },
    { no: '24', title: '新的可能', quote: '每一次重新整理\n都是为了腾出空间\n迎接下一段好消息', note: 'Making space for good news.' },
    { no: '25', title: '顺其自然', quote: '用尽全力之后\n学会把结果轻轻放下\n好事常在不经意间发生', note: 'Do your best, then let it breathe.' },
    { no: '26', title: '质感生活', quote: '所谓生活的质感\n不过是把一件件小事\n做得干净、利落、不将就', note: 'Care in small things shapes the day.' },
    { no: '27', title: '心有余地', quote: '遇到急事慢半拍\n心里留出三寸余地\n风雨来了也不慌', note: 'Keep a quiet margin inside.' },
    { no: '28', title: '静候佳音', quote: '流程还在往前走\n你的每一份用心\n都在静静等待回响', note: 'Good echoes are on their way.' },
    { no: '29', title: '热爱可抵', quote: '总有一些微小的喜欢\n能让你在疲惫的下午\n重新找回一点力气', note: 'Small joys recharge the afternoon.' },
    { no: '30', title: '清晰明亮', quote: '把复杂的事情拆小\n把模糊的边界理清\n心里就会亮堂很多', note: 'Clarity brings lightness.' },
    { no: '31', title: '向阳而生', quote: '哪怕今天只是阴天\n也要记得抬头看看\n云层后面一直有光', note: 'Light waits behind the clouds.' },
    { no: '32', title: '不负此刻', quote: '不必总去猜明天怎样\n把眼前这一刻过好\n未来自然不会差', note: 'Live this hour well.' },
    { no: '33', title: '舒展自在', quote: '像一棵树那样呼吸\n向下扎根，向上舒展\n不必成为任何人', note: 'Root deep, grow as yourself.' },
    { no: '34', title: '圆满收尾', quote: '每一笔账目都有去处\n每一份付出都有回音\n愿今日事事顺心', note: 'Every effort finds its home.' },
    { no: '35', title: '轻声鼓励', quote: '你已经做得很好了\n给自己一个小小的肯定\n明天再继续发光', note: 'You are doing better than you think.' },
    { no: '36', title: '熟悉的意外', quote: '在日复一日的秩序里\n永远为自己保留一点\n发现惊喜的眼睛', note: 'Stay open to quiet surprises.' }
  ];
  let i = Math.floor(Math.random() * lines.length);
  const paint = () => {
    const idx = i % lines.length;
    const L = lines[idx];
    card.classList.remove('is-shuffling');
    void card.offsetWidth;
    card.classList.add('is-shuffling');
    zh.textContent = `${L.no}.${L.title}`;
    en.textContent = L.quote;
    note.textContent = L.note;
    if (counter) counter.textContent = `${L.no} / ${String(lines.length).padStart(2, '0')}`;
    card.dataset.index = String(idx);
    card.dataset.scene = String(idx % 5);
  };
  paint();
  const next = () => { i = (i + 1) % lines.length; paint(); };
  btn.addEventListener('click', next);
  card.addEventListener('dblclick', next);
})();
