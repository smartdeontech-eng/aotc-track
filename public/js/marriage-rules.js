// Conditional logic for the Intended Marriage Interview Form (PCG-AOTC-CFL-FR01).
//
// One source of truth, loaded by BOTH the browser (to enable/disable fields and
// show what's outstanding) and the server (to gate "Send to Session"). Keeping
// them together means the screen and the gate can never disagree.
//
// Principle: a question only applies when its parent answer makes it meaningful.
// Fields that don't apply are set to "Not applicable" rather than left blank, so
// the printed form never looks like something was overlooked.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MarriageRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const NA = 'Not applicable';
  const yes = v => /^yes/i.test(String(v || '').trim());
  const no = v => /^no/i.test(String(v || '').trim());
  const answered = v => String(v == null ? '' : v).trim() !== '';

  // Does question `no` apply, given this person's (h|w) answers?
  // ans: the { q1: {h,w}, ... } block for section D.
  function applies(qNo, ans, who) {
    const a = n => ((ans['q' + n] || {})[who] || '');
    switch (qNo) {
      // "Married before?" = No  ->  7, 8, 9, 10 don't apply.
      case 7: case 8:
        return !no(a(6));
      case 9:  // divorce certificate — only for an Ordinance divorce
        return !no(a(6)) && (!answered(a(8)) || /divorc/i.test(a(8))) && (!answered(a(7)) || /ordinance/i.test(a(7)));
      case 10: // dissolution evidence — only for a Customary divorce
        return !no(a(6)) && (!answered(a(8)) || /divorc/i.test(a(8))) && (!answered(a(7)) || /customary/i.test(a(7)));
      // "Any children?" = No  ->  12–16 don't apply.
      case 12: case 13: case 14: case 16:
        return !no(a(11));
      case 15: // where are they staying — only when they are NOT staying with you
        return !no(a(11)) && (!answered(a(14)) || no(a(14)));
      default:
        return true;
    }
  }

  // Questions that must be answered before the form goes to Session.
  // Base questions are always required; dependants only when they apply AND
  // their parent has been answered in the triggering direction.
  const BASE_REQUIRED = [1, 2, 3, 4, 5, 6, 11];

  function requiredQuestions(ans, who) {
    const a = n => ((ans['q' + n] || {})[who] || '');
    const req = new Set(BASE_REQUIRED);
    if (yes(a(6))) { req.add(7); req.add(8); }
    if (yes(a(6)) && /divorc/i.test(a(8)) && /ordinance/i.test(a(7))) req.add(9);
    if (yes(a(6)) && /divorc/i.test(a(8)) && /customary/i.test(a(7))) req.add(10);
    if (yes(a(11))) { req.add(12); req.add(13); req.add(14); req.add(16); }
    if (yes(a(11)) && no(a(14))) req.add(15);
    return [...req].filter(n => applies(n, ans, who));
  }

  // Section E: a reason is required only when support is "No".
  function eReasonRequired(sideObj, parent /* 'father' | 'mother' */) {
    return no((sideObj || {})[parent + 'Support']);
  }

  // Everything still outstanding, as human-readable lines.
  function outstanding(form) {
    const f = form || {};
    const d = f.d || {}, e = f.e || {}, g = f.g || {}, b = f.b || {}, a = f.a || {};
    const out = [];
    if (!answered(a.date)) out.push('Section A — interview date');
    if (!((f.attendance || {}).presentMemberIds || []).length) out.push('Section A — tick the committee members present');
    if (!answered((b.husband || {}).name)) out.push('Section B — intended husband’s name');
    if (!answered((b.wife || {}).name)) out.push('Section B — intended wife’s name');

    [['h', 'Intended husband'], ['w', 'Intended wife']].forEach(([who, label]) => {
      requiredQuestions(d, who).forEach(n => {
        const v = (d['q' + n] || {})[who];
        if (!answered(v)) out.push(`Section D Q${n} — ${label}`);
      });
    });

    [['h', 'husband’s family'], ['w', 'wife’s family']].forEach(([side, label]) => {
      const s = e[side] || {};
      ['father', 'mother'].forEach(parent => {
        const sup = s[parent + 'Support'];
        const who = parent === 'father' ? 'Father' : 'Mother';
        if (!answered(sup)) out.push(`Section E — ${who} of the ${label}: support Yes/No`);
        else if (no(sup) && !answered(s[parent + 'Reasons'])) out.push(`Section E — reasons why the ${who} of the ${label} does not support`);
      });
    });

    if (!answered(g.recommendation)) out.push('Section G — recommendation to Session');
    else if (g.recommendation === 'concerns' && !answered(g.details)) out.push('Section G — details of the concerns');
    return out;
  }

  return { NA, applies, requiredQuestions, eReasonRequired, outstanding, helpers: { yes, no, answered } };
}));
