// AOTC Track — how visitors to the Session read in the minutes.
//
// One file for both sides: the Minutes page uses it to show each group's
// paragraph as it is typed, and utils/sessionMinutes.js uses the same code to
// print it, so the preview and the document can never say different things.
//
// A meeting can receive several GROUPS of visitors, each its own paragraph
// under "Presentation", in the order they were received. A group is one
// purpose (a presentation, a bereaved family, a couple to be married, a
// committee or group of the congregation, a courtesy call, anything else) and
// any number of people. They are NOT listed under IN ATTENDANCE: that list is
// for those who sat through the meeting or were invited to it.
//
// group = {
//   purpose: 'presentation' | 'funeral' | 'marriage' | 'seminarian' | 'committee' | 'courtesy' | 'other',
//   otherLabel,                       // the Clerk's own name for an 'other' visit (page only)
//   people: [{ name, role }],          // role: "Ghana Water Company", "son", "Secretary"
//   leader,                            // a name from people, when someone spoke for the group
//   from,                              // where they came from: "Kokomlemle", "Ghana Water Company"
//   introducedBy,                      // normally the Linguist; '__self__' when they introduced themselves
//   introducedByLinguist,              // true when introducedBy is the Linguist
//   why,                               // "to brief the Session on the borehole project"
//   deceased, relation, events[{what, date, time, venue, note}], funeralDetails,   // funeral
//   groom, bride, weddingDate,         // marriage ('YYYY-MM-DD'; older entries — the church wedding)
//   events (marriage): [{ what: 'traditional marriage' | 'church wedding' | 'thanksgiving service', date, time, venue, note }]
//   studentKind, seminary, studyYear, attachFrom, attachTo,   // seminarian: 'seminarian' | 'probationer'
//   entityName,                        // committee or group
//   letterId,                          // a letter they brought, kept in Correspondence
//   details,                           // what was said or presented
//   response, responseIsDecision,      // the Session's response; a Decision: line when it is one
//   title,                             // the item's heading, when the Clerk types his own
//   withdrew,                          // they left after their item
//   prayedFor, prayedBy,               // prayed for before they left, and by whom
// }
(function (root) {
  'use strict';
  const BLANK = '…………';
  const SELF = '__self__';           // introducedBy: they introduced themselves
  const t = (v) => String(v == null ? '' : v).trim();
  const or = (v) => t(v) || BLANK;
  const NUM = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const PURPOSES = [
    { key: 'presentation', label: 'Presentation' },
    { key: 'funeral', label: 'Funeral (a bereaved family)' },
    { key: 'marriage', label: 'Marriage' },
    { key: 'seminarian', label: 'Seminarian or ministerial probationer' },
    { key: 'committee', label: 'A committee or group' },
    { key: 'courtesy', label: 'Courtesy call' },
    { key: 'other', label: 'Other' },
  ];

  // "Saturday 21 November 2026" from a calendar day — never through a Date in
  // UTC, which reads the day before west of Greenwich.
  function longDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t(iso));
    if (!m) return t(iso);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
    return `${day} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }
  const sentence = (s) => { s = t(s); if (!s) return ''; s = s[0].toUpperCase() + s.slice(1); return /[.!?…]$/.test(s) ? s : `${s}.`; };
  const cleanPeople = (g) => (Array.isArray(g.people) ? g.people : []).map((p) => ({ name: t(p && p.name), role: t(p && p.role) })).filter((p) => p.name);

  // "Mr Kofi Mensah (Ghana Water Company)", the leader marked when the group had one.
  // A delegation has a leader; a family or a couple's party has a spokesperson.
  function person(p, leader, word) {
    const notes = [p.role, leader && p.name === leader ? (word || 'leader') : ''].filter(Boolean);
    return notes.length ? `${p.name} (${notes.join(', ')})` : p.name;
  }
  function list(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  // "to brief the Session…" joins the sentence; anything else stands on its own.
  function whyPart(why) {
    const w = t(why).replace(/[.]$/, '');
    if (!w) return { join: '', alone: '' };
    if (/^(to|for|in|on|with|regarding|concerning|about|as)\b/i.test(w)) return { join: `, ${w}`, alone: '' };
    return { join: '', alone: sentence(w) };
  }

  // A time as the minutes write it: "9:00 pm". "9am", "9:00 PM", "9.00 p.m.",
  // "21:00" all become that; anything that is not a time is left as typed.
  function clock(v) {
    const x = t(v).toLowerCase().replace(/\s+/g, '');
    const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a\.m\.?|p\.m\.?|a|p)?$/.exec(x);
    if (!m) return t(v);
    let h = Number(m[1]); const min = m[2] || '00'; let ap = m[3] ? m[3][0] : '';
    if (!ap && !m[2]) return t(v);               // a bare "9" is not a time
    if (!ap) { if (h === 0) { h = 12; ap = 'a'; } else if (h >= 12) { ap = 'p'; if (h > 12) h -= 12; } else ap = 'a'; }
    if (h < 1 || h > 12 || Number(min) > 59) return t(v);
    return `${h}:${min} ${ap}m`;
  }
  // Times inside running text, in the same style: "at 6:46pm", "9 AM",
  // "9.00 p.m." → "6:46 pm", "9:00 am", "9:00 pm". Only times that say am or
  // pm are touched, so Bible references ("John 3:16") and scores are safe.
  function fixTimes(text) {
    return String(text == null ? '' : text).replace(/\b(\d{1,2})(?:[:.](\d{2}))?\s?([ap])\.?\s?m\b\.?/gi, (all, h, mi, ap, off, whole) => {
      const hh = Number(h); const mm = mi || '00';
      if (hh < 1 || hh > 12 || Number(mm) > 59) return all;
      const end = off + all.length;
      // Keep a full stop that ended the sentence ("… at 9 p.m. The family …").
      const keepStop = /\.$/.test(all) && /^\s+[A-Z]/.test(whole.slice(end)) || /\.$/.test(all) && end === whole.length;
      return `${hh}:${mm} ${ap.toLowerCase()}m${keepStop ? '.' : ''}`;
    });
  }
  // He or she from the title when one person came and the title says;
  // "they" for a group or when the title does not tell.
  function pron(people) {
    const n = people.length === 1 ? people[0].name : '';
    if (n && /^(mr|master|bro|brother|nana)\b\.?/i.test(n)) return { subj: 'he', obj: 'him', poss: 'his', self: 'himself', one: true };
    if (n && /^(mrs|madam|miss|ms|maame|sis|sister|mad|auntie|aunty)\b\.?/i.test(n)) return { subj: 'she', obj: 'her', poss: 'her', self: 'herself', one: true };
    return { subj: 'they', obj: 'them', poss: 'their', self: 'themselves', one: people.length === 1 };
  }
  function self(people) { return pron(people).self; }
  const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  // No one named as introducing them: the paragraph goes straight in.
  const noIntro = (g) => !t(g.introducedBy);
  // "The one-week observance would be held on Saturday 14 November 2026 at
  // 9.00 a.m. at the AOTC premises." then whatever was said about it.
  function eventSentences(events) {
    return (Array.isArray(events) ? events : []).map((e) => {
      e = e || {};
      const what = t(e.what); if (!what && !t(e.date) && !t(e.venue)) return '';
      const label = what ? (/^(the|a|an)\b/i.test(what) ? what : `the ${what}`) : 'the funeral';
      let s1 = `${label[0].toUpperCase()}${label.slice(1)} would be held`;
      if (t(e.date)) s1 += ` on ${longDate(e.date)}`;
      if (t(e.time)) s1 += ` at ${clock(e.time)}`;
      if (t(e.venue)) s1 += ` at ${t(e.venue)}`;
      return [`${s1}.`, sentence(e.note)].filter(Boolean).join(' ');
    }).filter(Boolean).join(' ');
  }

  // An intended marriage is usually two occasions: the traditional (customary)
  // marriage, then the church wedding. "The traditional marriage would be held
  // on Saturday 14 November 2026 at 10:00 am at Kaneshie, and the church
  // wedding on Saturday 5 December 2026 at 1:00 pm at the AOTC Chapel."
  // Older entries carry only weddingDate: that is the church wedding.
  function marriageEvents(g) {
    let ev = (Array.isArray(g.events) ? g.events : []).filter((e) => e && (t(e.date) || t(e.time) || t(e.venue) || t(e.note)));
    if (!ev.length && t(g.weddingDate)) ev = [{ what: 'church wedding', date: g.weddingDate }];
    return ev;
  }
  function marriageSentence(g) {
    const ev = marriageEvents(g);
    if (!ev.length) return '';
    const when = (e) => [t(e.date) ? ` on ${longDate(e.date)}` : '', t(e.time) ? ` at ${clock(e.time)}` : '', t(e.venue) ? ` at ${t(e.venue)}` : ''].join('');
    const label = (e) => { const w = t(e.what) || 'marriage'; return /^(the|a|an)\b/i.test(w) ? w : `the ${w}`; };
    let s1;
    if (ev.length === 1) s1 = `${cap(label(ev[0]))} would be held${when(ev[0])}.`;
    else {
      // "A would be held on …, B on …, and C on …."
      const rest = ev.slice(1).map((e) => `${label(e)}${when(e)}`);
      s1 = `${cap(label(ev[0]))} would be held${when(ev[0])}, ${rest.length > 1 ? `${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}` : `and ${rest[0]}`}.`;
    }
    const notes = ev.map((e) => sentence(e.note)).filter(Boolean);
    return [s1, ...notes].join(' ');
  }

  // A seminarian on attachment, or a ministerial probationer, introduced to the
  // Session. As the minutes have put it: "Third-year seminarian from Trinity
  // Theological Seminary on attachment" (8 Oct 2026); "Mr Adolph Ahenkorah
  // Amankwah, a ministerial probationer, who was present as an observer as part
  // of his training" (9 Apr 2026).
  function studentWhat(g) {
    if (g.studentKind === 'probationer') return 'a ministerial probationer';
    const yr = t(g.studyYear).replace(/[-\s]*year$/i, '');
    const sem = t(g.seminary) || 'Trinity Theological Seminary';
    return `${yr ? `a ${yr}-year` : 'a'} seminarian from ${sem}`.replace(/^a ([aeiou])/i, 'an $1');
  }
  function studentStay(g, people) {
    const pr = pron(people);
    const who = pr.one ? (pr.subj === 'they' ? people[0].name : cap(pr.subj)) : 'They';
    // A period reads without the weekdays: "from 1 October 2026 to 31 December 2026".
    const d = (iso) => longDate(iso).replace(/^[A-Z][a-z]+day /, '');
    const span = t(g.attachFrom) && t(g.attachTo) ? ` from ${d(g.attachFrom)} to ${d(g.attachTo)}`
      : t(g.attachFrom) ? ` from ${d(g.attachFrom)}` : t(g.attachTo) ? ` until ${d(g.attachTo)}` : '';
    if (g.studentKind === 'probationer') {
      return span ? `${who} had been attached to the Congregation${span}.` : '';
    }
    return `${who} had been attached to the Congregation${span}.`;
  }

  // A bereaved family, in the order the minutes tell it: who came, whose
  // passing they announced, what else they said, the arrangements.
  function funeralParagraph(g, people, ctx) {
    const names = people.map((p) => (p.role ? `${p.name} (${p.role})` : p.name));
    const from = t(g.from);
    const who = names.length ? `${list(names)}${from ? ` ${/^(from|of)\b/i.test(from) ? from : `from ${from}`}` : ''}` : `The family of ${or(g.deceased)}`;
    const many = names.length !== 1;
    const pr = pron(people);
    const out = [];
    let introduced = true;
    if (g.introducedBy === SELF) out.push(`${who} introduced ${names.length ? pr.self : 'themselves'} to the Session.`);
    else if (!noIntro(g)) out.push(`${who} ${many ? 'were' : 'was'} introduced to the Session by ${introText(g)}.`);
    else introduced = false;
    const leader = many && t(g.leader) && people.some((p) => p.name === t(g.leader)) ? t(g.leader) : '';
    // Straight in when no one introduced them: the names open the announcement.
    const speaker = !introduced ? who : leader || (pr.one ? (pr.subj === 'they' ? people[0].name : cap(pr.subj)) : 'They');
    const rel = t(g.relation);
    if (t(g.deceased) && names.length) {
      out.push(`${speaker} announced the passing of ${rel ? `${pr.poss} ${rel}, ${t(g.deceased)}` : t(g.deceased)}.`);
    } else if (!introduced) {
      out.push(`${who} came before the Session.`);
    }
    // The announcement is already written from the deceased's name, so a reason
    // that only repeats it is left out; anything else they came for is added.
    const why = t(g.why).replace(/[.]$/, '');
    if (why && !(t(g.deceased) && /\b(passing|death|demise|died|bereave)/i.test(why))) {
      out.push(/^to\b/i.test(why) ? `${cap(pr.one && pr.subj !== 'they' ? pr.subj : (pr.one ? people[0].name : 'they'))} also came ${why}.` : sentence(why));
    }
    if (t(g.details)) out.push(sentence(g.details));
    const letter = letterPart(g, ctx, true, pr.poss);
    if (!letter.leaveArrangements) {
      const ev = eventSentences(g.events);
      if (ev) out.push(ev);
      if (t(g.funeralDetails)) out.push(sentence(g.funeralDetails));
    }
    if (letter.text) out.push(letter.text);
    return out;
  }
  // The letter they brought. One in THIS meeting's Correspondence is referred
  // to by its item number, and a funeral's arrangements are then left to it;
  // one from an earlier meeting is named by that meeting's date, and the
  // arrangements are told here in full. ctx.letterRef(id) → { current, no, date }.
  function letterPart(g, ctx, funeral, poss) {
    poss = poss || 'their';
    if (!t(g.letterId)) return { text: '', leaveArrangements: false };
    const ref = ctx && typeof ctx.letterRef === 'function' ? ctx.letterRef(g.letterId) : null;
    if (ref && !ref.current) {
      const when = t(ref.date) ? ` at the meeting of ${longDate(ref.date)}` : ' at an earlier meeting';
      return { text: `${cap(poss)} letter was received${when}${t(ref.no) ? ` (item ${t(ref.no)} of those minutes)` : ''}.`, leaveArrangements: false };
    }
    const see = ref && t(ref.no) ? `(see item ${t(ref.no)} under Correspondence)` : '(see Correspondence)';
    return funeral
      ? { text: `Details of the funeral arrangements are contained in ${poss} letter ${see}.`, leaveArrangements: true }
      : { text: `${cap(poss === 'their' ? 'they' : poss === 'his' ? 'he' : 'she')} also brought a letter ${see}.`, leaveArrangements: false };
  }
  function introText(g) {
    return t(g.introducedBy) && g.introducedByLinguist ? `the Linguist, ${t(g.introducedBy)}` : or(g.introducedBy);
  }

  function paragraph(g, ctx) {
    g = g || {};
    const people = cleanPeople(g);
    const leader = t(g.leader);
    const word = ['presentation', 'committee', 'courtesy'].includes(g.purpose || 'presentation') ? 'leader' : 'spokesperson';
    const names = people.map((p) => person(p, people.length > 1 ? leader : '', word));
    // "the Linguist, Presbyter Kwaku Koranteng" when it was the Linguist.
    const intro = introText(g);
    const purpose = g.purpose || 'presentation';
    const from = t(g.from); const fromText = from ? (/^(from|of)\b/i.test(from) ? from : `from ${from}`) : '';
    let subject; let short; let plural = false;
    let out;
    if (purpose === 'funeral') {
      out = funeralParagraph(g, people, ctx);
      short = 'The family';
    } else if (purpose === 'marriage') {
      subject = `${or(g.groom)} and ${or(g.bride)}${names.length ? `, accompanied by ${list(names)},` : ''}`;
      short = 'The couple'; plural = true;
      // Why a couple comes before the Session, unless the Clerk says otherwise.
      if (!t(g.why)) g = { ...g, why: 'to announce their intended marriage' };
    } else if (purpose === 'seminarian') {
      const n0 = names.length ? list(people.map((p) => p.name)) : `A ${g.studentKind === 'probationer' ? 'ministerial probationer' : 'seminarian'}, ${BLANK},`;
      subject = names.length ? `${n0}, ${studentWhat(g)}${names.length > 1 ? '' : ''},` : n0;
      plural = names.length > 1;
      if (plural) subject = `${n0}, ${g.studentKind === 'probationer' ? 'ministerial probationers' : `seminarians from ${t(g.seminary) || 'Trinity Theological Seminary'}`},`;
      short = names.length === 1 ? people[0].name : 'They';
      // A probationer sits in as an observer; that is why he is there.
      if (!t(g.why) && g.studentKind === 'probationer') {
        const pr = pron(people);
        g = { ...g, why: `${pr.one ? (pr.subj === 'they' ? people[0].name : cap(pr.subj)) : 'They'} ${pr.one && pr.subj !== 'they' ? 'was' : 'were'} present as an observer as part of ${pr.poss} training.` };
      }
    } else if (purpose === 'committee') {
      const ent = or(g.entityName);
      subject = `${/^the\b/i.test(ent) ? ent : `The ${ent}`}${names.length ? `, represented by ${list(names)},` : ''}`;
      short = names.length ? 'The delegation' : (/^the\b/i.test(ent) ? ent : `The ${ent}`);
    } else if (names.length > 1) {
      subject = `A delegation of ${NUM[names.length] || names.length}${fromText ? ` ${fromText}` : ''} — ${list(names)} —`;
      short = 'The delegation';
    } else if (names.length === 1) {
      subject = !fromText ? names[0] : (g.introducedBy === SELF || noIntro(g)) ? `${names[0]} ${fromText}` : `${names[0]}, ${fromText},`; short = people[0].name;
    } else {
      subject = `A visitor, ${BLANK},`; short = 'The visitor';
    }
    if (!out) {
      const why = whyPart(g.why);
      const verb = plural ? 'were' : 'was';
      // A courtesy call says so unless the reason already reads as a phrase.
      const call = purpose === 'courtesy' && !why.join ? ' on a courtesy call' : '';
      const how = g.introducedBy === SELF
        ? `introduced ${purpose === 'marriage' || purpose === 'committee' ? 'themselves' : self(people)} to the Session`
        : noIntro(g) ? 'came before the Session'
        : `${verb} introduced to the Session by ${intro}`;
      out = [`${subject} ${how}${call}${why.join}.`.replace(/ ,/g, ',').replace(/the Session, to /, 'the Session to ')];
      if (why.alone) out.push(why.alone);
      if (purpose === 'marriage') { const m = marriageSentence(g); if (m) out.push(m); }
      if (purpose === 'seminarian' && people.length) { const st = studentStay(g, people); if (st) out.push(st); }
      // What was said flows on in the same paragraph.
      if (t(g.details)) out.push(sentence(g.details));
      const letter = letterPart(g, ctx, false, purpose === 'presentation' || purpose === 'courtesy' || purpose === 'other' ? pron(people).poss : 'their');
      if (letter.text) out.push(letter.text);
    }
    const paras = [out.join(' ')];
    // The Session's response, then their leaving, close the group's paragraph.
    const tail = [];
    if (t(g.response)) tail.push(g.responseIsDecision ? `\nDecision: ${sentence(g.response)}` : ` ${sentence(g.response)}`);
    const gap = tail.length && g.responseIsDecision ? '\n' : ' ';
    // Visitors are often prayed for before they leave: "Presbyter Kwaku
    // Koranteng prayed for the family before they took leave of the Session."
    // One person who came alone is "her"/"him", never "the family".
    const pr = pron(people);
    const alone = pr.one && purpose !== 'marriage' && purpose !== 'committee';
    if (alone) short = pr.subj === 'they' ? people[0].name : cap(pr.subj);
    if (g.prayedFor) {
      const whom = alone ? (pr.subj === 'they' ? people[0].name : pr.obj)
        : purpose === 'funeral' ? 'the family' : purpose === 'marriage' ? 'the couple' : 'them';
      const by = t(g.prayedBy) || 'The Session';
      const after = alone ? (pr.subj === 'they' ? 'they' : pr.subj) : 'they';
      tail.push(`${gap}${by} prayed for ${whom}${g.withdrew ? (alone && pr.subj === 'they' ? ', who then took leave of the Session' : ` before ${after} took leave of the Session`) : ''}.`);
    } else if (g.withdrew) tail.push(`${gap}${short} then took leave of the Session.`);
    paras[paras.length - 1] += tail.join('');
    return paras.join('\n\n').replace(/^\s+/, '');
  }

  const real = (g) => g && (cleanPeople(g).length || t(g.deceased) || t(g.groom) || t(g.bride) || t(g.entityName) || t(g.why) || t(g.details));
  // Every group, one after another; '' when there are none.
  function visitorsBody(groups, ctx) {
    return (Array.isArray(groups) ? groups : []).filter(real).map((g) => paragraph(g, ctx)).join('\n\n');
  }

  // Each group's heading as its own numbered item (3.1, 3.2 …) under
  // Presentation. The Clerk may type his own (g.title); otherwise it is made
  // from the purpose: "Funeral Announcement — Ophelia Ama Nyarkoaa Obeng".
  function title(g) {
    g = g || {};
    if (t(g.title)) return t(g.title);
    const people = cleanPeople(g);
    const by = t(g.from) || (people.length ? (people.length === 1 ? people[0].name : `${people[0].name} and Others`) : '');
    switch (g.purpose || 'presentation') {
      case 'funeral': return t(g.deceased) ? `Funeral Announcement — ${t(g.deceased).replace(/^the late\s+/i, '')}` : 'Funeral Announcement';
      case 'marriage': return t(g.groom) || t(g.bride) ? `Intended Marriage — ${or(g.groom)} and ${or(g.bride)}` : 'Intended Marriage';
      case 'seminarian': {
        const who = people.length ? ` — ${list(people.map((p) => p.name))}` : '';
        return g.studentKind === 'probationer' ? `Ministerial Probationer${who}` : `Seminarian on Attachment${who}`;
      }
      case 'committee': return t(g.entityName) ? `Visit by ${/^the\b/i.test(t(g.entityName)) ? t(g.entityName) : `the ${t(g.entityName)}`}` : 'Visit by a Committee';
      case 'courtesy': return by ? `Courtesy Call by ${by}` : 'Courtesy Call';
      case 'other': return t(g.otherLabel) || (by ? `Visit by ${by}` : 'Visitors');
      default: return by ? `Presentation by ${by}` : 'Presentation';
    }
  }
  // The groups as items: [{ subject, body }].
  function visitorsItems(groups, ctx) {
    return (Array.isArray(groups) ? groups : []).filter(real).map((g) => ({ subject: title(g), body: paragraph(g, ctx) }));
  }
  // "The following presentation was received." / "… presentations were received."
  const visitorsLeadLine = (n) => (n === 1 ? 'The following presentation was received.' : 'The following presentations were received.');

  const api = { fixTimes, PURPOSES, paragraph, visitorsBody, visitorsItems, visitorsLeadLine, title, longDate, clock, SELF };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VisitorsText = api;
})(typeof window !== 'undefined' ? window : globalThis);
