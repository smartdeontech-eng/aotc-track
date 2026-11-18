// AOTC Track — Claude assist for correspondence.
//
// The Session Clerk photographs each letter received and, until now, pasted it
// into a chat assistant by hand to get a heading and a summary for the minutes.
// This module does that step inside the app: it sends the photo (or PDF, or
// pasted text) to the Anthropic API and gets back the three fields the minutes
// need — heading, summary, suggested action — drafted in the congregation's own
// house style. The clerk always reviews and edits before saving; nothing is
// written to the minutes automatically.
//
// Configuration (.env):
//   ANTHROPIC_API_KEY=sk-ant-...     required for this feature only
//   ANTHROPIC_MODEL=claude-opus-5-5     optional override (default is Opus 5.5)
// With no key set, the feature reports itself unavailable and the clerk simply
// types the heading and summary as before — nothing else in the app is affected.

const SM = require('./sessionMinutes');
const HOUSE_STYLE = require('./minutesHouseStyle');
const { isSunday } = require('./dates');
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';   // Opus 5.5, chosen Sept 2026 for better minute prose

// Actions the Session records against a correspondence item, taken from the
// congregation's existing minutes.
const ACTIONS = ['Approved', 'Not approved', 'Administrative', 'Acknowledged', 'Noted', 'To be announced', 'Deferred', 'Referred', 'For decision'];
// "Referred to the Committee on Welfare", "Forwarded to SMC" — the minutes name
// who a letter goes to, so those two are accepted with any body after them.
function actionFrom(v) {
  const t = String(v == null ? '' : v).trim();
  const exact = ACTIONS.find(a => a.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const m = t.match(/^(referred|forwarded) to\s+(.{2,120})$/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} to ${m[2].replace(/[.\s]+$/, '')}` : '';
}

function isConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || '').trim();
}

// House style distilled from the AOTC Session minutes of Dec 2025 / Jul 2026.
const SYSTEM_PROMPT = `You draft correspondence entries for the minutes of the Session of the Presbyterian Church of Ghana, Adabraka Official Town Congregation (PCG-AOTC).

You will be given a letter received by the Session (as one or more photographs, a PDF, or pasted text). Where several pages are supplied they are pages of the SAME letter, in order — read them as one document. Produce the three fields the minutes require.

HEADING
- A short title naming the type of correspondence, in Title Case.
- Where a body or family is involved, append it after an en dash.
- Examples in use: "Funeral Announcement"; "Permission to Use Chapel – GA West Presbytery Church Choirs' Union"; "Request for Funding – Children's Ministry and Junior Youth Christmas Party"; "Appreciation from the Atta-Darkwah Family".

SUMMARY
- One paragraph of formal minute prose, past tense, third person. Never first person, never bullet points.
- Name the sender the way the SESSION names them, not the way the letterhead does. "the Adabraka Official Town District", not "the District Session Council Standing Committee". Use the short name the Congregation would recognise.
- Open in the register the minutes use, matched to what the letter actually is:
    "A letter was received from … informing the Congregation of …"
    "A request was received from … seeking the Session's permission to …"
    "An invitation from … was received inviting …"
    "A letter of appreciation was received from …"
    "The Session was informed of …"

- SUMMARISE. DO NOT ENUMERATE. This is the single most important rule and the one most often broken.
  A schedule of many dates becomes its span or a phrase — "ahead of the event", "with proposed dates spanning 22nd August to 20th September 2026, including specific programme dates within the period".
  A list of venues becomes one compact phrase, keeping the Congregation groupings the letter uses.
  A programme of visits becomes what it is for, not a diary of it.
  Never reproduce a timetable line by line. The Session needs the shape of the thing and what is being asked of it, not the letter retyped.

- Keep what the Session must act on: amounts in full (GHS 17,850.00), dates written out (Sunday, 16th August 2026 at 9:00am), the places, and the names of people.
- Where the letter says more than one thing, join with "The letter further informed the Session that …" rather than starting again.
- Close on what is asked of the Congregation.
- British spelling. Titles as written, with no full stop (Rev, Catechist, Madam, Mrs, Mr, Ing, Dr); write "Madam" in full, never "Mad". Capitalise the Congregation, the Church and the Session.
- Do not invent, infer or embellish anything not in the letter. If a detail is unreadable, leave it out rather than guessing.
- 40 to 110 words, one paragraph. If it runs past 110 words you are enumerating; compress.

HOW THIS SESSION ACTUALLY WRITES THEM — match these:

  "A letter was received from the Ga West Presbytery informing the Congregation of the 2026 Catechists' Consecration, scheduled to take place on Friday, 27th March 2026 at 9:00am at PCG, AOTC."

  "A request was received from the District Standing Committee seeking the Session's permission for the District Mission and Evangelism Committee to use the church auditorium and projector for an Evangelism Consultation scheduled for Saturday, 16th May 2026 at 8:00am."

  "A letter was received from Emeralds of Praise seeking the Session's approval to organise the Shabach Experience 2026, a gospel musical programme, with proposed dates spanning 22nd August to 20th September 2026, including specific programme dates within the period."

  "A letter was received from the Oduu Piesie Asona family informing the Congregation of the funeral arrangements of the late Opanyin Kwame Antwi Boasiako, scheduled to take place from 13th to 14th June 2026 at Mpraeso-Kwahu, and requesting an introductory letter to the Trinity Congregation, PCG, Mpraeso."

WHAT COMPRESSION LOOKS LIKE — a letter carrying three venues and three dated publicity visits:

  WRONG, because it enumerates and names the sender formally:
  "A letter from the District Session Council Standing Committee was received inviting all Ministers, Catechists and Session Clerks to participate in a District Blood Donation Exercise organised in collaboration with the Committee on Development and Social Services. The exercise was scheduled for Sunday 16th August 2026 at 9:00am across three venues: Zone 1 at Adabraka Official Town Congregation, Zone 2 at Prince of Peace Congregation, and Zone 3 at Calvary Congregation. The letter noted that the district committee would visit various congregations during forenoon services with the medical team for publicity and education on 2nd August 2026 at Calvary Congregation and Faith Congregation, 9th August 2026 at Adabraka Official Town Congregation and Bethel Congregation, and 9th August 2026 at Prince of Peace Congregation and Ebenezer Congregation. Congregations were requested to collaborate and provide necessary logistics for the programme."

  RIGHT:
  "An invitation from the Adabraka Official Town District was received inviting all congregants to participate in the District Blood Donation Exercise scheduled for Sunday, 16th August 2026 at 9:00am. The exercise would be held simultaneously at three centres: Adabraka Official Town Congregation (AOT & BPC), Prince of Peace Congregation (PPC & EPC), and Calvary Congregation (CPC & NOP). The letter further informed the Session that district teams would visit the various congregations ahead of the event to undertake publicity and health education and requested the cooperation of the congregations to ensure the success of the programme."

ACTION
- The Session's disposition, one of: Approved, Not approved, Administrative, Acknowledged, Noted, To be announced, Deferred, For decision — or "Referred to <body>" / "Forwarded to <body>" naming who it goes to, e.g. "Referred to the Committee on Welfare", "Forwarded to SMC".
- "Approved" only where the letter records an approval already granted; "Not approved" only where it records a request already refused. A request awaiting the Session's decision is "For decision". Routine matters handled by staff are "Administrative". Letters of thanks, funeral announcements and notices requiring no action are "Acknowledged". An invitation or notice the congregants should hear about is "To be announced".
- Use "Referred to …" or "Forwarded to …" only where the letter itself is addressed to, or plainly belongs with, that body.
- This is only a SUGGESTION for the Session Clerk, who records what the Session actually did. If it is not clear from the letter, return "" — never guess, and never use "For decision" as a fallback.

Reply with ONLY a JSON object, no code fence and no commentary:
{"heading": "...", "summary": "...", "action": "...", "from": "...", "letterDate": "...", "eventDate": "..."}
"from" is the sender as they should be named in the minutes. "letterDate" is the date on the letter in YYYY-MM-DD form, or "" if none is shown. "eventDate" is the FIRST date the letter asks something of the congregation by — the funeral, the programme, the deadline for a reply — in YYYY-MM-DD form, or "" if the letter names none.`;

// Pull the JSON object out of the model's reply, tolerating a stray code fence
// or a sentence before it.
function parseDraft(text) {
  const raw = String(text || '').trim();
  let candidate = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Claude did not return a usable draft.');
    candidate = candidate.slice(start, end + 1);
  }
  let obj;
  try { obj = JSON.parse(candidate); } catch (e) { throw new Error('Claude did not return a usable draft.'); }
  const str = v => String(v == null ? '' : v).trim();
  const action = actionFrom(obj.action);
  return {
    heading: str(obj.heading).slice(0, 200),
    summary: str(obj.summary).slice(0, 4000),
    action,
    from: str(obj.from).slice(0, 200),
    letterDate: /^\d{4}-\d{2}-\d{2}$/.test(str(obj.letterDate)) ? str(obj.letterDate) : '',
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(str(obj.eventDate)) ? str(obj.eventDate) : '',
  };
}

// A single request may carry several pages of the same document — a letter
// photographed page by page, a roster that runs over two sheets. They are sent
// together, labelled in order, so the model reads them as one document.
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;   // what fits comfortably in one API call
function contentBlocksFor(files) {
  const list = (Array.isArray(files) ? files : [files]).filter(f => f && f.buffer && f.buffer.length);
  if (!list.length) return [];
  const total = list.reduce((n, f) => n + f.buffer.length, 0);
  if (total > MAX_UPLOAD_BYTES) {
    const mb = (total / 1024 / 1024).toFixed(1);
    const e = new Error(`Those ${list.length} pages come to ${mb} MB, which is more than can be read in one go. Photograph them at a lower resolution, or add them in two batches.`);
    e.status = 400;
    throw e;
  }
  const out = [];
  list.forEach((f, i) => {
    if (list.length > 1) out.push({ type: 'text', text: `Page ${i + 1} of ${list.length}:` });
    out.push(contentBlockFor(f));
  });
  return out;
}

// Anthropic accepts images as image blocks and PDFs as document blocks.
function contentBlockFor(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  const data = file.buffer.toString('base64');
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(mime)) {
    throw new Error('Please upload the letter as a JPG, PNG or PDF.');
  }
  return { type: 'image', source: { type: 'base64', media_type: mime, data } };
}

// files: array of multer files (the letter's pages, in order) — optional.
// text: pasted letter text — optional. At least one is required.
// Anything the Clerk has added about how he wants these written. It goes AFTER
// the house rules, so his correction always wins.
function styleBlock(note) {
  const t = String(note || '').trim();
  return t ? `\n\nTHE SESSION CLERK HAS ASKED FOR THE FOLLOWING. Where it differs from anything above, follow this:\n${t}` : '';
}

async function draftCorrespondence({ files, file, text, style }) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) {
    const e = new Error('Automatic summarising is not switched on. Add ANTHROPIC_API_KEY to the server .env file, or type the heading and summary yourself.');
    e.status = 503;
    throw e;
  }
  const content = contentBlocksFor(files || file);
  const typed = String(text || '').trim();
  if (typed) content.push({ type: 'text', text: `Letter text:\n\n${typed}` });
  if (!content.length) {
    const e = new Error('Attach a photo or PDF of the letter, or paste its text.');
    e.status = 400;
    throw e;
  }
  content.push({ type: 'text', text: 'Draft the minutes entry for this correspondence, treating every page above as one letter. Reply with only the JSON object.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);   // Opus is slower than Sonnet
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim(),
        max_tokens: 1500,
        system: SYSTEM_PROMPT + styleBlock(style),
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(err.name === 'AbortError'
      ? 'Summarising took too long. Please try again, or type the summary yourself.'
      : 'Could not reach Claude from the server. Check the server has internet access.');
    e.status = 502;
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) {}
    const e = new Error(
      res.status === 401 ? 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.'
        : res.status === 404 ? `The model "${(process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim()}" is not available on this key. Set ANTHROPIC_MODEL in .env to one you have.`
        : res.status === 429 ? 'Claude is rate-limited right now. Please try again in a moment.'
        : `Claude could not process the letter${detail ? ': ' + detail : '.'}`);
    e.status = 502;
    throw e;
  }

  const json = await res.json();
  const textOut = (json.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const draft = parseDraft(textOut);
  draft.usage = json.usage || null;
  return draft;
}

// ---- Shared caller ---------------------------------------------------------
async function callClaude(args) {
  return (await callClaudeFull(args)).text;
}
// As callClaude, but also says WHY Claude stopped. 'max_tokens' means the
// answer was cut off at the length cap — callers that parse JSON need to know,
// or a long answer just looks like a broken one.
// `thinking`: a budget of tokens Claude may spend reasoning before it writes
// (extended thinking). The answer still comes back as the text blocks only;
// the thinking is discarded. If the model or key refuses thinking, the call is
// made once more without it, so the feature never breaks on that account.
async function callClaudeFull({ system, content, maxTokens, thinking }) {
  if (thinking) {
    try {
      return await callClaudeOnce({ system, content, maxTokens, thinking });
    } catch (e) {
      if (!e.thinkingRefused) throw e;
      console.warn('[ai] extended thinking refused, retrying without:', e.message);
    }
  }
  return callClaudeOnce({ system, content, maxTokens });
}
async function callClaudeOnce({ system, content, maxTokens, thinking }) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) {
    const e = new Error('This feature needs ANTHROPIC_API_KEY in the server .env file.');
    e.status = 503;
    throw e;
  }
  const controller = new AbortController();
  // Opus is slower than Sonnet, and thinking first slower again.
  const timer = setTimeout(() => controller.abort(), thinking ? 240000 : 150000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
      body: JSON.stringify({
        model: (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim(),
        // With thinking, max_tokens must cover the thinking budget AND the answer.
        max_tokens: (maxTokens || 1500) + (thinking ? thinking : 0),
        system,
        messages: [{ role: 'user', content }],
        ...(thinking ? { thinking: { type: 'enabled', budget_tokens: thinking } } : {}),
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(err.name === 'AbortError' ? 'That took too long. Please try again.' : 'Could not reach Claude from the server.');
    e.status = 502;
    throw e;
  }
  clearTimeout(timer);
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) {}
    if (thinking && res.status === 400 && /thinking/i.test(detail)) {
      throw Object.assign(new Error(detail), { status: 502, thinkingRefused: true });
    }
    const e = new Error(res.status === 401 ? 'The Anthropic API key was rejected.'
      : res.status === 404 ? `The model "${(process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim()}" is not available on this key. Set ANTHROPIC_MODEL in .env to one you have.`
      : res.status === 429 ? 'Claude is rate-limited right now. Please try again shortly.'
      : `Claude could not complete that${detail ? ': ' + detail : '.'}`);
    e.status = 502;
    throw e;
  }
  const json = await res.json();
  if (json.stop_reason === 'max_tokens') {
    console.warn(`[ai] answer hit the length cap (max_tokens ${(maxTokens || 1500) + (thinking || 0)}; used ${json.usage ? json.usage.output_tokens : '?'} output tokens)`);
  }
  return {
    text: (json.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
    stopReason: json.stop_reason || '',
  };
}

// ---- Rough notes → minute prose --------------------------------------------
// The clerk types terse notes while the meeting runs; this turns them into the
// formal paragraph the minutes use. It may only rephrase — never add a fact,
// a name, a figure or an outcome that is not in the notes.
const POLISH_PROMPT = `You turn a Session Clerk's rough meeting notes into the formal prose used in the minutes of the Session of the Presbyterian Church of Ghana, Adabraka Official Town Congregation.

YOUR ONE JOB IS TO CHANGE THE REGISTER, NOT THE CONTENT.
The notes are written the way people speak. The minutes are written the way a court records itself. Every fact, figure, name and outcome stays exactly as given; every spoken turn of phrase becomes formal minute prose.

STYLE
- Formal minute prose, past tense, third person. Never first person, never bullet points, never headings.
- Name people as the minutes do, with their title.
- Reporting verbs the minutes use: informed the Session, reported, briefed the Session, indicated, added, explained, enquired, advised, entreated, requested, directed, noted, commended, suggested, recommended.
- British spelling. Amounts in full (GHS 17,850.00). Dates written out (29th June 2026).
PARAGRAPHING — the rule is the SUBJECT turning, never the speaker changing.
- Most items are short: a sentence or two, and one paragraph. Across this congregation's 2026 minutes, 145 of 199 items are a single paragraph, and their median length is 23 words.
- Where an item carries a real discussion, break it. Those items run to 115 words and often far more, and their paragraphs average about 40 words.
- Start a new paragraph when the item TURNS to a different matter — a different aspect of the project, a different arrangement, a different question raised. The same person continuing on a new matter starts a new paragraph: "He further reported that …", "On site issues, …".
- Do NOT start a new paragraph merely because a different member has spoken. A question and the answer to it belong in the same paragraph. A short exchange among three or four members on one point is one paragraph.
- Never leave a single sentence standing as its own paragraph inside a discussion already under way.

- A reply is attributed: "In response, Ing Kwaku Koranteng indicated that …".
- A decision of the court reads: "After deliberation, the Session agreed that …".

SPOKEN ENGLISH THAT MUST BE CONVERTED
These are habits of speech, not of minutes. Convert every one:
  "sat down to review"        → "reviewed"
  "somewhere in 2016"         → "in 2016"
  "rather owing"              → "owing"
  "from where he sat, he felt"→ "he indicated that"
  "hinted that"               → "indicated that" or "suggested that"
  "once they got to that area"→ "when the matter arose"
  "prepare in a way to embrace it" → "prepare for the possibility"
  "in the negative"           → "against the contractor", or whatever the sense plainly is
  "the said amount"           → "that amount"
Anything else of the same character goes the same way. If a phrase would sound out of place read aloud to the Session, it does not belong in the minutes.

NEVER MANUFACTURE A CONNECTIVE — this is the rule most often broken.
Do not write "so", "therefore", "thus", "this indicated that", "as a result" or "accordingly" unless the notes themselves assert that link. Where the notes simply state one figure after another, state them one after another: "He stated that the outstanding mobilisation stood at GHS 735,379.26." An invented "so" makes correct figures read as though they do not add up, and is worse than a plain sentence.

FIGURES
- Reproduce every figure exactly as given, in the order given.
- Never compute, reconcile, total or correct a figure. If the notes state a total, state it; if they do not, do not supply one.
- Where the notes describe how one figure was reached, keep that description; do not improve the arithmetic.

ABSOLUTE RULE
Use ONLY what is in the notes. Do not invent names, figures, dates, decisions, reasons or outcomes. Do not resolve an ambiguity by guessing — leave the point as vague as the notes leave it. Changing clumsy English into minute prose is required; changing what was said is forbidden.

WHAT THIS LOOKS LIKE — a Building Committee report, as it came out WRONG and as it should read:

  WRONG. The spoken words were written down instead of converted, and a "so" was
  invented that made correct figures read as though they did not add up:
  "The Building Committee sat down to review this claim and arrived at a figure of GHS 235,379.26 in the negative. He explained that this indicated that the contractor was rather owing the Congregation the said amount. He explained that somewhere in 2016 the contractor was given GHS 500,000.00 before the commencement of the project and that money was still being owed by the contractor. When the project was halted and then resumed, the contractor was also advanced mobilization of GHS 50,000.00 for material money, and this had been paid by the contractor. Another advanced mobilization of GHS 100,000.00 would be settled in the current certificate raised, so the outstanding mobilization amount was GHS 735,379.26."

  RIGHT. Same speakers, same figures, nothing added or removed — the register
  converted, and no connective the notes did not assert:
  "He reported that the Building Committee had reviewed the claim and arrived at a figure of GHS 235,379.26 against the contractor, indicating that the contractor was owing the Congregation that amount. He explained that in 2016 the contractor was given GHS 500,000.00 before the commencement of the project, and that this sum was still owed. He added that when the project was halted and later resumed, the contractor was advanced a further GHS 50,000.00 for materials, which had since been repaid, and that a further advance of GHS 100,000.00 would be settled in the certificate currently raised. He stated that the outstanding mobilisation stood at GHS 735,379.26."

  Note what changed: "sat down to review" became "reviewed"; "in the negative"
  became "against the contractor"; "rather owing" became "owing"; "the said
  amount" became "that amount"; "somewhere in 2016" became "in 2016"; and the
  invented "so" became "He stated that".

PRAYER POINTS AND ANY OTHER LIST ARE NOT PROSE.
Where the notes give a run of points — the Prayers item, above all — do NOT roll
them into a sentence and do NOT number them. Write the lead-in as a line ending
in a colon, then ONE POINT PER LINE, each capitalised, with no full stop and no
"and" joining the last two. If a sentence of prose follows the list, leave a
BLANK LINE before it. The app turns those lines into bullets when it builds the
Word and PDF documents, exactly as the congregation's own minutes set them.

  WRONG
  The Senior Presbyter led the Session in prayer on the following: that God's
  presence would be with the Congregation at all times, that the Chapel would
  never again be flooded, and for the protection of congregants and their
  families from ailments and premature death.

  RIGHT
  The Senior Presbyter led the Session in prayer on the following:
  God's presence with the Congregation at all times
  Protection of the Chapel from further flooding
  Protection of congregants and their families from ailments and premature death

  Following the prayers led by the Senior Presbyter, the District Minister led
  the members of the Session to pray for one another.

WHERE THE BREAKS FALL — one item from the minutes of 9th July 2026, in four paragraphs.
Note that paragraph 2 keeps the SAME speaker and still starts anew, because the
matter changed; and that a member's question and its answer stay together.

  [1] "Ing Sampson Agudze updated the Session on the status of the Building Project. He informed the Session that the Building Committee had recommended that 50% of the consultancy fee request of GHS 234,000.00 be paid …"
        — the consultancy fee.

  [2] "Ing Sampson Agudze further reported that the contractor had submitted a request for payment of Interim Payment Certificate No. 9 to the tune of GHS 318,798.52 …"
        — same speaker, but the matter has turned to the payment certificate.

  [3] "On site issues, Ing Kwaku Koranteng indicated that the two pumps currently on site were not functioning and were yet to be replaced …"
        — the matter has turned again, to the site.

  [4] "Rev J. R. Tettey added that, with regard to the Church's Harvest programmes, it would be prudent to cost specific materials needed for the Building Project …"
        — and again, to the Harvest programmes.

HOW A DISCUSSION IS RECORDED — from this Session's own minutes:

  "Madam Esther Boatemaa enquired whether, given that the contractor was owing the Congregation, the contractor would be in a position to pay once the contract was terminated. Ing Sampson Agudze indicated that he could not speak to the contractor's position, but that he would know how to proceed when the matter arose. In response, Ing Kwaku Koranteng indicated that if the contractor had no funds it would be difficult to pay the workers engaged on the client's behalf."

  "The Senior Presbyter, on behalf of the Session, commended the Building Committee for the work done so far."

  "After deliberation, the Session agreed that the contractor should be written to for a meeting to discuss reverting to funding the project as the contract originally provided, and that the contractor be given two weeks to respond officially."

Length is not a fault. This Session's entries run to six hundred words where the discussion warranted it. Record every contribution the notes carry; do not compress a debate into a summary. Break that length into paragraphs at each turn of subject-matter, as above.

Return ONLY the finished prose. No preamble, no commentary, no quotation marks around the whole thing.`;

// The Session's own roster, handed to the model so a hurried "A. Twum" in the
// notes comes back as "Mr Emmanuel Adjei Twum". The list is the only source of
// names it may expand to; anyone not on it is left exactly as written, which is
// what keeps visitors and outside bodies intact.
function peopleBlock(people) {
  // Each entry is a name, or { full, short } where the member has a short form
  // of his own (set on the roster, or learned from the Clerk's corrections).
  const list = (people || []).filter(Boolean).map(x => typeof x === 'string' ? { full: x } : x).filter(x => x.full);
  if (!list.length) return '';
  const withShort = list.some(x => x.short);
  return `

THE PEOPLE OF THIS SESSION${withShort ? ' (where a member has his or her own short form, it follows "short:" — use it EXACTLY for every mention after the first in an item)' : ''}
${list.map(x => `  ${x.full}${x.short ? `   short: ${x.short}` : ''}`).join('\n')}

When the notes refer to one of these people by surname, by initials, or by any
short form, write the full name exactly as it appears in that list — including
the title. Never expand a name that is not on the list, and never guess between
two people on it: if you cannot tell which is meant, leave the notes' own
wording untouched.`;
}

// `lead` is the sentence the app has ALREADY written for this item — the
// devotion and the constituting of the Session write themselves from the times
// and names the Clerk captured. Without telling the model about it, the tidied
// notes open by saying the same thing again:
//   "The meeting commenced at 6.32 p.m. Ing Kwaku Koranteng led the Session in
//    devotion, leading the singing of three stanzas of PH 603."
//   "Ing Kwaku Koranteng led the Session in the opening prayer and devotion. He
//    reflected on …"
// Paragraphs one after another, with no empty line between them (the Clerk's
// request, Oct 2026: it saves space, and the printed minutes never showed the
// gap anyway). The one blank line kept is the one that matters: after an
// unmarked list (a lead-in ending in ":" and its points), a blank line is what
// returns the text to prose — see bulletise() in utils/sessionMinutes.js.
function tightParagraphs(text) {
  const lines = String(text || '').split('\n');
  const marked = lines.some(l => /^\s*[-*•–—]\s+/.test(l));
  const out = [];
  let listing = false, gap = false;
  lines.forEach(raw => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { gap = true; return; }
    if (gap && listing && !marked) out.push('');
    gap = false;
    if (gap === false && /:$/.test(line.trim()) && !marked) listing = true;
    else if (out.length && out[out.length - 1] === '') listing = false;
    out.push(line);
  });
  return out.join('\n');
}

// Long items (21 Oct 2026: the Clerk's "on Members" item stopped part-way and
// was refused). Claude's thinking can run past its budget, and the formal
// prose is longer than the notes, so a long item could still hit the length
// cap. Now: far more room first; and if an answer still stops short, the notes
// are split at a paragraph (or sentence) break and the parts are tidied at the
// same time, the later parts told they carry on from the earlier ones. Only a
// part that cannot be split any further is refused — and then, as before, the
// Clerk's notes are left exactly as they were.
const TOO_LONG = 'These notes are too long to tidy in one go \u2014 the tidy-up stopped before the end, so your notes have NOT been changed. Split them into two items (or tidy half at a time) and try again.';
function splitNotes(text) {
  const paras = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  let units = paras, joiner = '\n';
  if (units.length < 2) {
    units = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
    units = units.map(x => x.trim()).filter(Boolean);
    joiner = ' ';
  }
  if (units.length < 2) return null;
  const total = units.reduce((n, u) => n + u.length, 0);
  let acc = 0, cut = 1;
  for (let i = 0; i < units.length - 1; i++) { acc += units[i].length; if (acc >= total / 2) { cut = i + 1; break; } cut = i + 1; }
  return [units.slice(0, cut).join(joiner), units.slice(cut).join(joiner)];
}
async function polishNotes(args, depth = 0) {
  const text = String(args.notes || '').trim();
  if (!text) {
    const e = new Error('There are no notes to tidy up.');
    e.status = 400;
    throw e;
  }
  const one = await polishOnce({ ...args, notes: text });
  if (one.stopReason !== 'max_tokens') return finishPolish(text, one.text);
  // Thinking is what usually runs away with the room (it can go well past its
  // budget). So first try the same notes again WITHOUT thinking — the answer
  // alone then has all the room — and only split if even that is too long.
  if (!args.noThinking && thinkingOn()) {
    console.warn('[ai] tidy-up: cut off while thinking — trying again without thinking');
    args = { ...args, noThinking: true };
    const plain = await polishOnce({ ...args, notes: text });
    if (plain.stopReason !== 'max_tokens') return args._raw ? { text: tightParagraphs(String(plain.text || '').trim()) } : finishPolish(text, plain.text);
  }
  const parts = depth < 2 ? splitNotes(text) : null;
  if (!parts) throw Object.assign(new Error(TOO_LONG), { status: 502 });
  console.warn(`[ai] tidy-up: splitting a long item (${(text.match(/\S+/g) || []).length} words) into two parts`);
  const [a, b] = await Promise.all([
    polishNotes({ ...args, notes: parts[0], _raw: true }, depth + 1),
    polishNotes({ ...args, notes: parts[1], lead: '', continuation: true, _raw: true }, depth + 1),
  ]);
  const joined = `${a.text}\n${b.text}`;
  return args._raw ? { text: joined } : finishPolish(text, joined);
}
function finishPolish(text, out) {
  const words = (text.match(/\S+/g) || []).length;
  const result = tightParagraphs(String(out || '').trim());
  if (!result) throw Object.assign(new Error('The tidy-up came back empty, so your notes have not been changed. Please try again.'), { status: 502 });
  // A tidied minute is never a fraction of the notes it came from: the house
  // style records every contribution. Much shorter means something was dropped,
  // and the page asks before using it.
  const outWords = (result.match(/\S+/g) || []).length;
  return { text: result, inWords: words, outWords, suspectShort: words >= 120 && outWords < words * 0.55 };
}
function thinkingOn() { return String(process.env.AI_TIDY_THINKING || '1') !== '0'; }
async function polishOnce({ notes, subject, people, lead, meetingDate, extraRules, continuation, noThinking }) {
  const text = notes;
  const already = String(lead || '').trim();
  const leadBlock = already ? `

THIS SENTENCE IS ALREADY PRINTED IMMEDIATELY ABOVE WHAT YOU RETURN:

  "${already}"

Your text follows it directly, in the same item. So:
  - Do NOT re-state who led, what was sung, or what the reading was.
  - Do NOT open by naming that person again as though introducing them.
  - Begin with what came NEXT — the substance of what was said or done.
  - Refer back with "He", "She" or "The Session" where you must refer at all.

WRONG (repeats the printed sentence):
  Ing Kwaku Koranteng led the Session in the opening prayer and devotion. He
  reflected on the many signs and wonders Jesus had performed …

RIGHT (carries straight on):
  He reflected on the many signs and wonders Jesus had performed …` : '';
  // The length cap was a flat 2000 tokens until Oct 2026. A long item — the
  // new minister's address on 24 Sept, about 1,100 words of dictated notes —
  // needed more than that, the answer stopped part-way, and the page put the
  // half-finished text IN PLACE of the notes, so the rest of what the Clerk had
  // typed was gone. Now the cap grows with the notes, and an answer that still
  // stops short is refused outright: the notes are never replaced by part of
  // themselves.
  const words = (text.match(/\S+/g) || []).length;
  // Thinking first (Oct 2026, at the Clerk's request): the same model in the
  // Claude desktop app turned long dictated notes into far better minutes,
  // reasoning about who said what and where each subject turns before writing.
  // The budget grows with the notes. AI_TIDY_THINKING=0 in .env turns it off.
  const think = (noThinking || !thinkingOn()) ? 0
    : Math.min(12000, Math.max(2048, Math.round(words * 4)));
  const contBlock = continuation ? `

THESE NOTES ARE THE LATER PART OF ONE AGENDA ITEM. The earlier part has already been minuted and is printed immediately above what you return. So:
  - Do NOT open with an introduction, a heading or a summary of the item.
  - Carry straight on from where the earlier part stopped.
  - People are likely to have been named in full already: after that first mention, the house style for later mentions applies.` : '';
  // Room for the answer: formal minute prose runs longer than the notes, so
  // about four tokens a word, never less than 4,000. Thinking gets its own
  // budget on top (callClaudeOnce adds it), plus the same again as headroom,
  // because thinking can run past its budget and must not eat the answer.
  const room = Math.min(16000, Math.max(4000, Math.round(words * 4) + 2000));
  const { text: out, stopReason } = await callClaudeFull({
    system: POLISH_PROMPT + HOUSE_STYLE + approvedRulesBlock(extraRules) + peopleBlock(people) + leadBlock + contBlock + yearBlock(meetingDate),
    maxTokens: room + (think || 0),
    thinking: think || undefined,
    content: [{ type: 'text', text: `${subject ? `Agenda item: ${subject}\n\n` : ''}Notes:\n${text}` }],
  });
  return { text: out, stopReason };
}

// A month with no year ("this was to start in October") is the meeting's year.
function yearBlock(meetingDate) {
  const y = /^(\d{4})-\d{2}-\d{2}$/.test(String(meetingDate || '')) ? meetingDate.slice(0, 4) : '';
  return y ? `

THIS MEETING WAS HELD ON ${meetingDate}. Where the notes name a month or a day with no year, it is ${y} unless the notes say otherwise: "start in October" becomes "start in October ${y}".` : '';
}

// ---- Treasurer's statement → figures ---------------------------------------
// Reads a photograph of the finance statement into the grid the minutes use.
// Totals are deliberately NOT trusted: the app recomputes them and compares.
function financePrompt(accounts) {
  return `You read a photograph of the Treasurer's financial statement for a church Session meeting and return the figures as JSON.

The church keeps these accounts (use exactly these keys):
${accounts.map(a => `  ${a.key} = ${a.label}`).join('\n')}

For each account find, where shown:
  opening    the opening balance
  cash       receipts received in cash
  chequeDt   receipts by cheque or direct transfer
  momo       receipts by mobile money
  payments   total payments / expenditure

Reply with ONLY this JSON object, no code fence and no commentary:
{
  "asOf": "YYYY-MM-DD or empty string",
  "values": {
    "opening":  {"<accountKey>": number, ...},
    "cash":     {...}, "chequeDt": {...}, "momo": {...}, "payments": {...}
  },
  "stated": { "opening": number|null, "closing": number|null, "payments": number|null },
  "unreadable": ["short note for any figure you could not read with confidence"]
}

RULES
- Numbers only — no currency symbols, no thousands separators, no quotes. 1234.56 not "1,234.56".
- Omit an account from a row entirely if that row is blank or shows a dash for it. Never write a guessed number.
- "stated" is for TOTALS printed on the statement itself, so the app can check its own arithmetic against them. Use null where no total is printed.
- If a figure is smudged, cropped or ambiguous, leave it out and say so in "unreadable". A missing figure is safe; a wrong figure is not.`;
}

async function readFinanceStatement({ files, file, accounts }) {
  const pages = contentBlocksFor(files || file);
  if (!pages.length) {
    const e = new Error('Attach a photo or PDF of the statement.');
    e.status = 400;
    throw e;
  }
  const list = (accounts && accounts.length) ? accounts : [
    { key: 'gcb', label: 'GCB' }, { key: 'ecobank', label: 'ECOBANK' },
    { key: 'nib', label: 'NIB' }, { key: 'welfare', label: 'GCB (WELFARE)' },
  ];
  const out = await callClaude({
    system: financePrompt(list),
    maxTokens: 2000,
    content: pages.concat([{ type: 'text', text: 'Read the figures from this statement. Reply with only the JSON object.' }]),
  });
  let raw = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!raw.startsWith('{')) {
    const s = raw.indexOf('{'), e2 = raw.lastIndexOf('}');
    if (s === -1 || e2 <= s) throw Object.assign(new Error('Claude did not return usable figures.'), { status: 502 });
    raw = raw.slice(s, e2 + 1);
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('Claude did not return usable figures.'), { status: 502 }); }

  const keys = new Set(list.map(a => a.key));
  const numOnly = o => {
    const out2 = {};
    Object.entries(o || {}).forEach(([k, v]) => {
      if (!keys.has(k)) return;
      const n = Number(String(v).replace(/[, ]/g, ''));
      if (Number.isFinite(n)) out2[k] = n;
    });
    return out2;
  };
  const values = {};
  ['opening', 'cash', 'chequeDt', 'momo', 'payments'].forEach(r => { values[r] = numOnly((obj.values || {})[r]); });
  const stated = {};
  ['opening', 'closing', 'payments'].forEach(k => {
    const v = (obj.stated || {})[k];
    const n = v === null || v === undefined || v === '' ? null : Number(String(v).replace(/[, ]/g, ''));
    stated[k] = Number.isFinite(n) ? n : null;
  });
  return {
    asOf: /^\d{4}-\d{2}-\d{2}$/.test(String(obj.asOf || '')) ? obj.asOf : '',
    values,
    stated,
    unreadable: (Array.isArray(obj.unreadable) ? obj.unreadable : []).map(s => String(s).slice(0, 200)).slice(0, 12),
  };
}

// ---- Presbyters on Duty roster → dated pairs -------------------------------
// The congregation rosters two presbyters per Sunday, half a year at a time.
// The sheet may arrive as a photo, a PDF or a spreadsheet export; this reads it
// into dated pairs for the clerk to check before anything is saved.
function podPrompt(year, half) {
  const span = half === 2 ? 'July to December' : 'January to June';
  return `You read a "Presbyters on Duty" roster for the Presbyterian Church of Ghana, Adabraka Official Town Congregation, and return it as JSON.

The roster covers ${span} ${year}. Two presbyters are on duty each Sunday.

Reply with ONLY this JSON object, no code fence and no commentary:
{
  "entries": [
    {"date": "YYYY-MM-DD", "names": ["First Presbyter", "Second Presbyter"]}
  ],
  "unreadable": ["short note for anything you could not read with confidence"]
}

RULES
- Every "date" must be a Sunday in ${span} ${year}. The sheet may show only a day and month (e.g. "4th January", "04/01") — supply the year ${year} yourself. If a date is not a Sunday in that span, leave the row out and say so in "unreadable".
- Keep names exactly as written, including titles: Mr., Mrs., Ms., Mad., Ing., Dr., Rev., Catechist. Do not expand initials, reorder names, or correct spellings.
- Usually two names per Sunday. If the sheet clearly shows one, return one; if it shows more, return them all.
- Rows may be laid out in columns or in a grid — read them in date order.
- Never invent a name or a date to fill a gap. A missing Sunday is safe; a wrong one is not. Note any Sunday you could not read in "unreadable".`;
}

async function readPodRoster({ files, file, year, half }) {
  const pages = contentBlocksFor(files || file);
  if (!pages.length) {
    const e = new Error('Attach the roster as a photo, PDF or spreadsheet.');
    e.status = 400;
    throw e;
  }
  const y = Number(year) || new Date().getFullYear();
  const h = Number(half) === 2 ? 2 : 1;
  const out = await callClaude({
    system: podPrompt(y, h),
    maxTokens: 4000,
    content: pages.concat([{ type: 'text', text: 'Read this roster, treating every page above as one roster. Reply with only the JSON object.' }]),
  });
  let raw = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!raw.startsWith('{')) {
    const s = raw.indexOf('{'), e2 = raw.lastIndexOf('}');
    if (s === -1 || e2 <= s) throw Object.assign(new Error('Claude did not return a usable roster.'), { status: 502 });
    raw = raw.slice(s, e2 + 1);
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('Claude did not return a usable roster.'), { status: 502 }); }

  // Keep only real Sundays inside the requested half-year.
  const lo = `${y}-${h === 2 ? '07' : '01'}-01`;
  const hi = `${y}-${h === 2 ? '12-31' : '06-30'}`;
  const seen = new Set();
  const entries = (Array.isArray(obj.entries) ? obj.entries : []).map(e => ({
    date: String((e && e.date) || '').slice(0, 10),
    names: (Array.isArray(e && e.names) ? e.names : []).map(n => String(n).trim().slice(0, 120)).filter(Boolean).slice(0, 4),
  })).filter(e => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || e.date < lo || e.date > hi || !e.names.length) return false;
    if (!isSunday(e.date)) return false;                 // Sundays only
    if (seen.has(e.date)) return false;
    seen.add(e.date);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  return {
    year: y, half: h, entries,
    unreadable: (Array.isArray(obj.unreadable) ? obj.unreadable : []).map(s => String(s).slice(0, 200)).slice(0, 20),
  };
}

// ---- A letter brought by visitors to the Session ---------------------------
// Reads the photographed letter for the Visitors form: who wrote it, whom it is
// about and the arrangements. Only what the letter actually says — blanks for
// anything it does not. The Clerk checks every field before it is used.
const VISITOR_LETTER_PROMPT = `You read letters brought to the Session (the elders' court) of a Presbyterian congregation in Ghana by visitors — a bereaved family announcing a funeral, a couple seeking to marry, a delegation, a committee.
Reply with ONLY a JSON object, no commentary:
{
 "purpose": "funeral" | "marriage" | "seminarian" | "presentation" | "committee" | "courtesy" | "other",  (seminarian = a seminarian on attachment or a ministerial probationer)
 "heading": "a short register heading, e.g. Funeral Announcement — the late Ophelia Ama Nyarkoaa Obeng",
 "summary": "the entry for the Correspondence item, in minutes style (past tense, third person): what the letter says, with EVERY date, time, venue and arrangement written out as sentences, e.g. 'The one-week observance would be held on Saturday 14 November 2026 at 9.00 a.m. at the AOTC premises.'",
 "from": "where the writers come from — a place, church or company — or empty",
 "people": [{"name": "with title as written, e.g. Madam Gladys Ameyaw", "role": "e.g. daughter, or empty"}],
 "deceased": "full name of the deceased as written, without 'the late', or empty",
 "relation": "who the deceased was to the writers, e.g. mother, or empty",
 "events": [{"what": "e.g. one-week observance, wake-keeping, burial service, thanksgiving service", "date": "YYYY-MM-DD or empty", "time": "e.g. 9am or empty", "venue": "e.g. the AOTC premises", "note": "anything else said about it, as a sentence in the past-future ('the family would …'), or empty"}],
 "groom": "", "bride": "", "weddingDate": "YYYY-MM-DD or empty",
 "why": "for anything other than a funeral: why they came, starting 'to …', or empty"
}
Use only what the letter says. Never invent names, dates or places. Dates without a year take the year of the letter.`;
async function readVisitorLetter({ files, file }) {
  const pages = contentBlocksFor(files || file);
  if (!pages.length) throw Object.assign(new Error('Attach a photo or PDF of the letter first.'), { status: 400 });
  const out = await callClaude({
    system: VISITOR_LETTER_PROMPT,
    maxTokens: 2000,
    content: pages.concat([{ type: 'text', text: 'Read this letter, treating every page above as one letter. Reply with only the JSON object.' }]),
  });
  let raw = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a === -1 || b <= a) throw Object.assign(new Error('Claude could not read the letter. Fill the details in by hand.'), { status: 502 });
  let o;
  try { o = JSON.parse(raw.slice(a, b + 1)); } catch (e) { throw Object.assign(new Error('Claude could not read the letter. Fill the details in by hand.'), { status: 502 }); }
  const s = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(s(v)) ? s(v) : '');
  return {
    purpose: ['funeral', 'marriage', 'seminarian', 'presentation', 'committee', 'courtesy', 'other'].includes(o.purpose) ? o.purpose : '',
    heading: s(o.heading, 200), summary: s(o.summary, 2000), from: s(o.from, 160),
    people: (Array.isArray(o.people) ? o.people : []).slice(0, 20).map(p => ({ name: s(p && p.name, 120), role: s(p && p.role, 120) })).filter(p => p.name),
    deceased: s(o.deceased, 160), relation: s(o.relation, 60),
    events: (Array.isArray(o.events) ? o.events : []).slice(0, 8).map(e => ({ what: s(e && e.what, 80), date: day(e && e.date), time: s(e && e.time, 20), venue: s(e && e.venue, 200), note: s(e && e.note, 600) })).filter(e => e.what || e.date || e.venue),
    groom: s(o.groom, 120), bride: s(o.bride, 120), weddingDate: day(o.weddingDate), why: s(o.why, 400),
  };
}

// ---- Matters still outstanding ---------------------------------------------
// Reads a set of minutes and says what the Session has NOT finished with, so
// the register and the next Matters Arising start from something rather than
// from a blank page. It proposes; the Clerk decides. It is told in the
// strongest terms not to invent, because a fabricated outstanding matter is
// worse than a missed one — it would put words in the Session's mouth.
const MATTERS_PROMPT = `You read the minutes of a Session meeting of the Presbyterian Church of Ghana, Adabraka Official Town Congregation, and list what the Session has left unfinished.

An item is OUTSTANDING when the minutes show any of these:
  - a matter deferred, stood down, or referred to a later meeting
  - an instruction or assignment given to a person or a committee, with no record of it being completed
  - a decision the Session said it would take later, or awaited information on
  - a request, application or letter received but not yet answered
  - a report the Session asked for and has not yet received

An item is NOT outstanding when the minutes show it concluded: a decision taken and acted on, a report received and adopted, correspondence answered, a matter closed.

For each outstanding item return:
  heading   the AGENDA HEADING the item sits under in these minutes, copied EXACTLY as the minutes print it — "Update on Building Project", "Update on Letter to Head Office", "Church Finance Report". This is the numbered item's own Subject line, NOT a heading you compose. Several outstanding items usually share one heading, and that is expected: it is how they are gathered back onto the next agenda.

            ONE EXCEPTION, and only this one. Some Subject lines are containers rather than subjects: "Other Matters", "Any Other Business", "A.O.B.", "Announcements", "Correspondence", "General Matters", "Matters Arising" itself. Carrying a container onto the next agenda says nothing — it neither names the concern nor separates two unrelated ones raised in the same breath. Where the Subject line is a container, do NOT copy it. Write instead a short heading of three to six words naming the AREA OF CONCERN, taken from the words the minutes themselves use for it: "Chapel Washrooms", "Security of the Manse", "Church Bus", "Quotas to the General Assembly". Name the thing, not what is being done about it — "Chapel Washrooms", not "Repairing the chapel washrooms are needed". Two unrelated concerns raised under one container get two different headings. Never return a container label as a heading.
  subject   a BRIEF label for THIS particular item — the act itself, three to seven words, in the minutes' own words. It sits as a line under the heading, so it must be short enough to scan, and it must distinguish this item from the others under the same heading. Give the act, not the qualification of it: where the minutes say "Letter to contractor regarding reverting to original contract terms and requesting for meeting", the subject is "Letter to contractor" and everything after "regarding" belongs in the detail. "Seeking legal counsel before proceeding with termination of contractor" gives "Seeking legal counsel". "Submission of letter to Head Office with copies to the Clerk" gives "Submission of letter to Head Office". Never copy the whole instruction into the subject.
  detail    one or two sentences saying what is outstanding and what is awaited
  owner     the person or body responsible EXACTLY as the minutes name them, or "" if the minutes do not say
  status    "open" if nothing has been done, "in-progress" if work is under way, "decided" if the Session decided but the decision is still to be carried out

ABSOLUTE RULE
Use ONLY what is in the minutes. Never invent a matter, a name, a date or an obligation. Never infer that something must be outstanding because the minutes are silent — silence is not evidence. If the minutes show nothing unfinished, return an empty list. It is far better to return nothing than to return something the Session did not say.

Return ONLY a JSON object of this shape, with no commentary:
{"matters":[{"heading":"","subject":"","detail":"","owner":"","status":"open"}]}

WORKED EXAMPLE — three separate outstanding items, ONE heading between them:
{"matters":[
 {"heading":"Update on Building Project","subject":"Letter to contractor","detail":"A letter was to be written to the contractor on reverting to the original contract terms, and a meeting requested. Neither has yet been done.","owner":"Ing Sampson Agudze","status":"in-progress"},
 {"heading":"Update on Building Project","subject":"Seeking legal counsel","detail":"Legal counsel was to be sought before proceeding with the termination of the contractor. The opinion is awaited.","owner":"Ing Sampson Agudze","status":"open"},
 {"heading":"Update on Letter to Head Office","subject":"Submission of letter to Head Office","detail":"The letter was to be submitted to the Head Office with copies to the Session Clerk. It has not yet been submitted.","owner":"The Session Clerk","status":"open"}
]}
Note what that example does: TWO items under "Update on Building Project", each briefly labelled, each with the full instruction in its detail. The next agenda will carry "Update on Building Project" once, and dealing with it deals with both.

WORKED EXAMPLE — a container Subject line. The minutes print "8.0 Other Matters" and under it two unrelated concerns. "Other Matters" is NOT the heading; each concern gets its own:
{"matters":[
 {"heading":"Chapel Washrooms","subject":"State of the chapel washrooms","detail":"It was reported that the washrooms are in a poor state. The Property Committee was asked to inspect them and report.","owner":"The Property Committee","status":"open"},
 {"heading":"Security of the Manse","subject":"Night security at the manse","detail":"Concern was expressed about security at the manse at night. Nothing has yet been arranged.","owner":"","status":"open"}
]}`;

// Matters from these minutes that are already in the register. Telling Claude
// to leave them out is what lets a second reading reach the items a first,
// cut-off reading never got to.
function skipBlock(skip) {
  const list = (skip || []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 120);
  if (!list.length) return '';
  return `These matters from these minutes are ALREADY in the register. Do NOT list them again; list only the others:\n${list.map(x => '- ' + x).join('\n')}\n\n`;
}

// Pull every COMPLETE {...} object out of a "matters" array that may have been
// cut off part-way. Walks the text tracking strings and nesting, so a brace or
// quote inside a detail cannot fool it; the half-written last object is dropped.
function salvageMatters(raw) {
  const s = String(raw || '');
  const start = s.indexOf('[', Math.max(0, s.indexOf('"matters"')));
  if (start === -1) return [];
  const out = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { out.push(JSON.parse(s.slice(objStart, i + 1))); } catch (e) {}
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  return out;
}

// The matters the Session is already carrying. An item in these minutes that
// is one of them continuing comes back marked "continues", so it becomes an
// UPDATE to that matter rather than a second entry (Oct 2026).
function registerBlock(register) {
  const list = (register || []).filter(m => m && m.id && m.subject).slice(0, 150);
  if (!list.length) return '';
  return `

MATTERS ALREADY IN THE REGISTER, STILL OPEN (from earlier meetings)
${list.map(m => `  [${m.id}] ${m.heading ? m.heading + ' \u2014 ' : ''}${m.subject}${m.detail ? ': ' + String(m.detail).slice(0, 160) : ''}`).join('\n')}

When an item in these minutes is ONE OF THESE MATTERS COMING UP AGAIN — progress reported on it, a further instruction about it, a decision on it, or it being completed — do not present it as a new matter. Return it with "continues": the number in square brackets, keep that matter's heading and subject, and make "detail" say what THESE minutes add (what was reported, decided or still awaited). Set "status" to "decided" if the Session decided it, "in-progress" if work is under way, "closed" if these minutes show it completed. Only use "continues" when it is plainly the same matter; a new matter under the same heading is new.`;
}

async function proposeMatters({ minutes, people, skip = [], register = [] }) {
  const text = String(minutes || '').trim();
  if (!text) {
    const e = new Error('There is nothing in those minutes to read.');
    e.status = 400;
    throw e;
  }
  // The cap was 3000 tokens until Oct 2026. The 24 Sept 2026 minutes — the
  // longest yet, with more open items than any before — produced a list longer
  // than that; it was cut off mid-item, the half-written JSON would not parse,
  // and the Clerk saw "Claude did not return a usable list" for that one date
  // while shorter minutes worked. Each matter costs ~100 tokens, so 6000 holds
  // about 50, and stays inside the proxy's time limit at Opus's speed.
  const { text: out, stopReason } = await callClaudeFull({
    system: MATTERS_PROMPT + peopleBlock(people) + registerBlock(register),
    maxTokens: 6000,
    content: [{ type: 'text', text: `Minutes:\n${text}\n\n${skipBlock(skip)}Reply with only the JSON object.` }],
  });
  let raw = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let obj = null, truncated = stopReason === 'max_tokens';
  if (!truncated) {
    let whole = raw;
    if (!whole.startsWith('{')) {
      const a = whole.indexOf('{'), b = whole.lastIndexOf('}');
      whole = a !== -1 && b > a ? whole.slice(a, b + 1) : '';
    }
    try { obj = whole ? JSON.parse(whole) : null; } catch (e) { obj = null; }
  }
  // Cut off (or otherwise unparseable): keep every matter that WAS written in
  // full rather than throwing the whole reading away.
  if (!obj) {
    const items = salvageMatters(raw);
    if (!items.length) throw Object.assign(new Error(truncated
      ? 'Claude\u2019s list was cut off before a single matter was complete. Please try again.'
      : 'Claude did not return a usable list.'), { status: 502 });
    obj = { matters: items };
    truncated = true;
  }
  const ok = ['open', 'in-progress', 'decided', 'closed'];
  return {
    truncated,
    matters: (Array.isArray(obj.matters) ? obj.matters : []).map(m => ({
      // The agenda heading this belongs under. Several matters share one, and
      // that is the point — the next agenda carries the HEADING, and dealing
      // with it deals with everything gathered beneath it.
      //
      // The prompt forbids container labels, but a returned "Other Matters"
      // would put two unrelated concerns on one agenda line and name neither,
      // so it is not taken on trust: headingFor falls back to the item's own
      // subject, or composes one from the detail when the subject is a
      // container too.
      heading: SM.headingFor(
        String(m.heading || '').trim().slice(0, 200),
        String(m.subject || '').trim().slice(0, 200),
        String(m.detail || m.subject || '')
      ),
      // Brief enough to read as a line under the heading. The full instruction
      // stays in the detail, so the guard costs nothing.
      subject: SM.shortSubject(String(m.subject || '').trim(), 70)
        || String(m.subject || '').trim().slice(0, 200),
      detail: String(m.detail || '').trim().slice(0, 4000),
      owner: String(m.owner || '').trim().slice(0, 160),
      status: ok.includes(m.status) ? m.status : 'open',
      continues: Number(m.continues) > 0 ? Number(m.continues) : null,
    })).filter(m => m.subject),
  };
}

// ---- Proofreading: the Clerk's directive on a comment (Oct 2026) ------------
// The proofreader left a comment; the Clerk says what is to be done about it;
// this rewrites THAT paragraph accordingly and nothing else.
async function applyDirective({ paragraph, comment, anchor, directive, people, extraRules }) {
  const para = String(paragraph || '').trim();
  const dir = String(directive || '').trim();
  if (!para || !dir) throw Object.assign(new Error('Need the paragraph and your directive.'), { status: 400 });
  const { text } = await callClaudeFull({
    system: `You edit one paragraph of the minutes of the Session of the Presbyterian Church of Ghana, Adabraka Official Town Congregation.
The proofreader left a comment on it. The Session Clerk has given a directive saying what to do. Carry out the directive exactly, on this paragraph only.
- Change only what the directive asks for. Every other word, name, figure and fact stays as it is.
- Keep the minutes' style: formal, past tense, third person, British spelling.
- If the directive says to leave the paragraph unchanged, return it unchanged.
- Never add facts the directive does not give.
Return ONLY the finished paragraph — no quotation marks, no commentary.` + HOUSE_STYLE + approvedRulesBlock(extraRules) + peopleBlock(people),
    maxTokens: 2000,
    content: [{ type: 'text', text: `PARAGRAPH:\n${para}\n\nTHE PROOFREADER'S COMMENT${anchor ? ` (on the words "${anchor}")` : ''}:\n${comment || ''}\n\nTHE SESSION CLERK'S DIRECTIVE:\n${dir}` }],
  });
  const out = String(text || '').trim().replace(/^"([\s\S]*)"$/, '$1');
  if (!out) throw Object.assign(new Error('Nothing came back. Please try again.'), { status: 502 });
  return { text: out };
}

// ---- Proofreading: a rule the Clerk just taught, carried through the rest of
// the minutes being proofread (Oct 2026). Returns only the paragraphs that break
// the rule, each rewritten with that one fix and nothing else. The route adds
// them as new pending changes, so the Clerk still accepts or rejects each one.
async function applyRuleElsewhere({ rule, wrong, right, paragraphs }) {
  const r = String(rule || '').trim();
  const list = (paragraphs || []).filter(p => p && String(p.text || '').trim());
  if (!r || !list.length) return { edits: [] };
  // Long minutes go in batches, so no single answer is cut short.
  const batches = [];
  let cur = [], size = 0;
  for (const p of list) {
    const n = String(p.text).length;
    if (cur.length && size + n > 24000) { batches.push(cur); cur = []; size = 0; }
    cur.push(p); size += n;
  }
  if (cur.length) batches.push(cur);
  const edits = [];
  for (const batch of batches) {
    const { text, stopReason } = await callClaudeFull({
      system: `You check paragraphs of the minutes of the Session of the Presbyterian Church of Ghana, Adabraka Official Town Congregation, against ONE rule of style the Session Clerk has just laid down.
Find the paragraphs that break this rule and correct ONLY that. Every other word, name, figure, punctuation mark and fact stays exactly as it is.
Leave out every paragraph that already follows the rule, or that the rule does not touch. Do not improve anything else. If no paragraph breaks the rule, return no edits.
Return ONLY JSON: {"edits":[{"i":<the paragraph's number>,"text":"<the whole corrected paragraph>"}]}`,
      maxTokens: 8000,
      content: [{ type: 'text', text: `THE RULE:\n${r}${wrong ? `\nWRONG: ${wrong}` : ''}${right ? `\nRIGHT: ${right}` : ''}\n\nPARAGRAPHS:\n${batch.map(p => `[${p.i}] ${p.text}`).join('\n\n')}` }],
    });
    if (stopReason === 'max_tokens') throw Object.assign(new Error('The check was cut short. Please try again.'), { status: 502 });
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    let obj = null; try { obj = JSON.parse(raw.slice(a, b + 1)); } catch (e) {}
    if (!obj || !Array.isArray(obj.edits)) throw Object.assign(new Error('Claude did not return a usable check.'), { status: 502 });
    const ids = new Set(batch.map(p => p.i));
    obj.edits.forEach(e => {
      const i = Number(e && e.i), t = String((e && e.text) || '').trim();
      if (ids.has(i) && t) edits.push({ i, text: t });
    });
  }
  return { edits };
}

// ---- Proofreading: corrections → proposed house-style rules ------------------
// Only corrections that are a HABIT become rules; facts and one-off wording do
// not. Nothing is adopted here — the Clerk approves each rule.
async function suggestRules({ corrections, comments, existing }) {
  const list = (corrections || []).slice(0, 120);
  if (!list.length) return { rules: [] };
  const { text, stopReason } = await callClaudeFull({
    system: `You study a proofreader's corrections to the minutes of a church Session, to teach the minutes tidy-up not to make the same mistakes again.
Find the corrections that are HABITS — the same kind of change made more than once, or a rule of style the proofreader plainly applies (punctuation, capitals, word choice, sentence length, how names and titles are written). Ignore one-off corrections of fact or of what was said.
Do not propose a rule the existing rules already cover.
For each habit return: "rule" (one plain sentence, as an instruction), "wrong" and "right" (a short real example taken from the corrections), "times" (how many corrections it explains).
Return ONLY JSON: {"rules":[{"rule":"","wrong":"","right":"","times":1}]}`,
    maxTokens: 3000,
    thinking: 3000,
    content: [{ type: 'text', text: `EXISTING RULES:\n${(existing || []).map(r => '- ' + r).join('\n') || '(none beyond the standard house style)'}\n\nCORRECTIONS (before → after):\n${list.map((c, i) => `${i + 1}. ${c.before}\n   → ${c.after}`).join('\n')}\n\nCOMMENTS:\n${(comments || []).map(c => '- ' + c).join('\n') || '(none)'}` }],
  });
  if (stopReason === 'max_tokens') throw Object.assign(new Error('The list of suggestions was cut short. Please try again.'), { status: 502 });
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let obj = null; try { obj = JSON.parse(raw.slice(a, b + 1)); } catch (e) {}
  if (!obj || !Array.isArray(obj.rules)) throw Object.assign(new Error('Claude did not return usable suggestions.'), { status: 502 });
  return { rules: obj.rules.map(r => ({
    rule: String(r.rule || '').trim().slice(0, 400), wrong: String(r.wrong || '').trim().slice(0, 400),
    right: String(r.right || '').trim().slice(0, 400), times: Math.max(1, Number(r.times) || 1),
  })).filter(r => r.rule) };
}

// Rules the Clerk approved from proofreading, added to the house style for
// every tidy-up. Kept in the database (house_style_rules), not in code, so an
// approved rule works at once — no deploy.
function approvedRulesBlock(rules) {
  const list = (rules || []).filter(r => r && r.rule && r.active !== false);
  if (!list.length) return '';
  return `

RULES THE SESSION CLERK APPROVED FROM LATER PROOFREADING
${list.map((r, i) => `${i + 1}. ${r.rule}${r.wrong ? `\n   WRONG: ${r.wrong}` : ''}${r.right ? `\n   RIGHT: ${r.right}` : ''}`).join('\n')}`;
}

module.exports = {
  tightParagraphs,
  draftCorrespondence, readVisitorLetter, isConfigured, ACTIONS, parseDraft, contentBlocksFor, styleBlock, SYSTEM_PROMPT, POLISH_PROMPT,
  MATTERS_PROMPT,
  polishNotes, readFinanceStatement, readPodRoster, proposeMatters, salvageMatters,
  applyDirective, suggestRules, approvedRulesBlock, applyRuleElsewhere,
  callClaudeFull,
};
