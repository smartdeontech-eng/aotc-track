// AOTC Track — where the Session sits: the venue box, shared by the Session
// Meetings page and the Session Minutes page.
//
// The list is the Session's own (Rev Adu-Mante Hall, then the Chapel, then
// whatever the Clerk has added), served by /api/minutes/venues. The box offers
// it in that order, then "+ Add a new venue…" — which puts a venue on the list
// for every later meeting — and "Other (this meeting only)…", which does not.
// A venue already recorded on a meeting stays selectable even if it is not on
// the list, so an old meeting never loses its venue.
window.SessionVenues = (function () {
  let list = [], def = '';
  const ADD = '__add__', OTHER = '__other__';
  const e = s => (window.esc ? esc(s) : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

  async function load() {
    try {
      const v = await api('/minutes/venues');
      list = (v.venues || []).map(x => x.name);
      def = v.defaultVenue || list[0] || '';
      return v;
    } catch (err) { list = []; def = ''; return {}; }
  }
  function options(current) {
    const cur = String(current || '').trim();
    const names = list.slice();
    if (cur && !names.some(n => n.toLowerCase() === cur.toLowerCase())) names.unshift(cur);
    return names.map(n =>
      `<option value="${e(n)}"${cur && n.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${e(n)}</option>`
    ).join('')
      + `<option value="${ADD}">+ Add a new venue…</option>`
      + `<option value="${OTHER}">Other (this meeting only)…</option>`;
  }
  function value(sel, other) {
    return sel.value === OTHER ? String(other.value || '').trim() : sel.value;
  }
  // sel / other are elements or ids. onPick(name) runs when a venue is chosen,
  // added, or typed into the Other box.
  function bind(sel, other, onPick) {
    sel = typeof sel === 'string' ? document.getElementById(sel) : sel;
    other = typeof other === 'string' ? document.getElementById(other) : other;
    let prev = sel.value;
    sel.addEventListener('focus', () => { if (sel.value !== ADD && sel.value !== OTHER) prev = sel.value; });
    sel.addEventListener('change', async () => {
      if (sel.value === ADD) {
        const name = await promptDialog('The name of the venue, as it should appear on notices, the agenda and the minutes:',
          { title: 'Add a venue', okText: 'Add', placeholder: 'e.g. Church Office' });
        const typed = String(name || '').trim();
        if (!typed) { sel.innerHTML = options(prev); return; }
        try {
          const r = await api('/minutes/venues', { method: 'POST', body: { name: typed } });
          list = (r.venues || []).map(x => x.name);
          const added = r.added || typed;
          sel.innerHTML = options(added);
          other.style.display = 'none';
          prev = added;
          toast(`${added} added to the venue list.`);
          if (onPick) onPick(added);
        } catch (err) { toast(err.message, true); sel.innerHTML = options(prev); }
        return;
      }
      const isOther = sel.value === OTHER;
      other.style.display = isOther ? '' : 'none';
      if (isOther) { other.value = ''; other.focus(); return; }
      prev = sel.value;
      if (onPick) onPick(sel.value);
    });
    other.addEventListener('change', () => {
      const v = String(other.value || '').trim();
      if (v && onPick) onPick(v);
    });
  }
  return { load, options, value, bind, get list() { return list.slice(); }, get defaultVenue() { return def; } };
})();
