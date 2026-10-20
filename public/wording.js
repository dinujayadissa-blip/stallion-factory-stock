// Cleaned-up wording on screen (Small fixes & phone round 1, user-r4-2).
//
// The production plan and dealer orders have typos ("Battert Stop", "SERVISE DOORS", "Caravan Treading Center").
// The database keeps the text exactly as it came in, so the Excel export and a re-import of the sheet still
// match the spreadsheet. Only what people READ is cleaned: every text on the page (and hover tips) goes
// through tidyWords(). Values inside boxes you type in, and the hidden keys the screens send back to the
// office PC, are never changed — so saving something never rewrites the plan's text by accident.
// Add a word here and it is fixed on every screen (office and worker) at once.
(function () {
  // [typo, correct] — matched as whole words, any case; the case of the original is kept
  // ("SERVISE" → "SERVICE", "Servise" → "Service", "servise" → "service").
  const FIXES = [
    ['Battert', 'Battery'],
    ['Mattt', 'Matt'],
    ['Barthroom', 'Bathroom'],
    ['Tpilet', 'Toilet'],
    ['Roof Baw', 'Roof Bow'],
    ['Controler', 'Controller'],
    ['Seperating', 'Separating'],
    ['Seperate', 'Separate'],
    ['Seperated', 'Separated'],
    ['Aeria', 'Area'],
    ['Servise', 'Service'],
    ['Tethford', 'Thetford'],
    ['Thedford', 'Thetford'],
    ['Reflecters', 'Reflectors'],
    ['Reflecter', 'Reflector'],
    // the dealer: 64 vans say "Treading", ST0377 says "Trading" — one name on every van
    ['Caravan Treading Center', 'Caravan Trading Center'],
    // Follow-up round 1 (planner-r3-4): seen on ST0388, Purchasing → Special parts and every van's
    // "Wheel Braze" plan column. ("Braze" only inside "Wheel Braze": brazing is a real word.)
    ['Wheel Braze', 'Wheel Brace'],
    ['Axel', 'Axle'],
    ['Flar', 'Flat'],
    ['God STD', 'Gold STD'],
    ['shelvesv', 'shelves'],
    ['LArge', 'Large'],
    ['brush nickel', 'brushed nickel'],
  ];
  const MAP = new Map(FIXES.map(([a, b]) => [a.toLowerCase(), b]));
  // Longest first, so "Seperated" wins over "Seperate". \b keeps "AERIAL" and "Battery" untouched.
  const RE = new RegExp(`\\b(${FIXES.map(f => f[0]).sort((a, b) => b.length - a.length)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
  // One word: ALL CAPS stays all caps, lower case stays lower case, otherwise a capital first letter.
  const caseWord = (from, to) => from.length > 1 && from === from.toUpperCase() && from !== from.toLowerCase() ? to.toUpperCase()
    : from[0] === from[0].toLowerCase() ? to.toLowerCase() : to[0].toUpperCase() + to.slice(1);
  // Word by word when the fix has as many words as the text ("God STD" → "Gold STD", "Brush Nickel" →
  // "Brushed Nickel", "LArge" → "Large"); otherwise the whole text's case, as before.
  const keepCase = (from, to) => {
    const fw = from.split(/\s+/), tw = to.split(' ');
    if (fw.length === tw.length) return tw.map((w, i) => caseWord(fw[i], w)).join(' ');
    return from === from.toUpperCase() && from !== from.toLowerCase() ? to.toUpperCase()
      : from[0] === from[0].toLowerCase() ? to.toLowerCase() : to;
  };

  function tidyWords(s) {
    if (s == null) return s;
    s = String(s);
    RE.lastIndex = 0;
    if (!RE.test(s)) return s;
    RE.lastIndex = 0;
    return s.replace(RE, m => keepCase(m, MAP.get(m.toLowerCase().replace(/\s+/g, ' ')) || m));
  }

  // Clean every text node (and title="" tip) under a node. Skips boxes you type in and scripts.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT']);
  function tidyNode(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      const p = node.parentNode;
      if (p && SKIP.has(p.nodeName)) return;
      const t = tidyWords(node.nodeValue);
      if (t !== node.nodeValue) node.nodeValue = t;
      return;
    }
    if (node.nodeType !== 1 || SKIP.has(node.nodeName)) return;
    if (node.title) { const t = tidyWords(node.title); if (t !== node.title) node.title = t; }
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => (n.nodeType === 1 && SKIP.has(n.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === 3) { const t = tidyWords(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; }
      else if (n.title) { const t = tidyWords(n.title); if (t !== n.title) n.title = t; }
    }
  }

  function start() {
    tidyNode(document.body);
    new MutationObserver(recs => {
      for (const r of recs) {
        if (r.type === 'characterData') tidyNode(r.target);
        else if (r.type === 'attributes') { const t = tidyWords(r.target.title); if (t !== r.target.title) r.target.title = t; }
        else r.addedNodes.forEach(tidyNode);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title'] });
  }

  globalThis.tidyWords = tidyWords;
  if (typeof document !== 'undefined') {
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }
})();
