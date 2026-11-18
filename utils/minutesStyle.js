// AOTC Track's minutes, as the congregation's own documents have them.
//
// The engine — numbering, the agenda clock, motions, the Word and PDF builders —
// is @deontech/minutes, shared with every other DeonTech app. What is AOTC's is
// here: the measurements taken off the Session's own 2025–26 minutes and agenda
// (see the notes that used to head utils/sessionDocx.js, kept in git history and
// in AGENDA-LOOK.md), the masthead, the confidentiality line, the fonts.
const path = require('path');

const T = (f) => path.join(__dirname, '..', 'templates', f);
const MASTHEAD = ['PRESBYTERIAN CHURCH OF GHANA', 'ADABRAKA OFFICIAL TOWN CONGREGATION'];
const CONFIDENTIAL = 'This document is an exclusive property of Presbyterian Church of Ghana, '
  + 'Adabraka Official Town Congregation (PCG-AOTC) Session. Any disclosure, unauthorized '
  + 'reproduction or use is strictly prohibited except with permission from PCG-AOTC Session.';
// Committee and group minutes are that body's property, not the Session's.
const ownFooter = (text, owner) => text.split('(PCG-AOTC) Session.').join(`(PCG-AOTC) ${owner}.`).split('PCG-AOTC Session.').join(`PCG-AOTC ${owner}.`);
const F = (f) => path.join(__dirname, 'fonts', f);

module.exports = {
  minutes: {
    // Headings, the roster, the No. column and the Subject headings are Times
    // New Roman 12pt; item bodies, the Action column and signatures Verdana 10pt.
    font: 'Times New Roman', bodyFont: 'Verdana', size: 24, bodySize: 20, smallSize: 20, line: 360,
    cols: [635, 8084, 1838], indent: -765, posTab: 6237,
    // Points (prayer topics and the like) justified like the prose around
    // them — the Clerk's request, 21 Oct 2026.
    justifyPoints: true,
    defaultHeading: 'AOTC SESSION MEETING',
    signatures: { recorded: 'Recorded by', confirmed: 'Confirmed by', recordedTitle: 'Session Clerk', confirmedTitle: 'Minister-in-Charge', shade: 'D9E2F3' },
    templates: [T('session-minutes-template.docx'), T('minutes-template.docx')],
    masthead: MASTHEAD,
    owner: ownFooter,
  },
  agenda: {
    // News Gothic MT for the masthead and title only; the table is the
    // template's own Calibri, with headings in Calibri Light, #1F4E79.
    titleFont: 'News Gothic MT', headFont: 'Calibri Light', blue: '1F4E79',
    cols: [2141, 4678, 3989], indent: -180, defaultHeading: 'SESSION MEETING',
    templates: [T('session-agenda-template.docx'), T('session-minutes-template.docx')],
    masthead: MASTHEAD,
  },
  pdf: {
    crest: path.join(__dirname, '..', 'public', 'img', 'logo.png'),
    masthead: MASTHEAD,
    confidential: (owner) => (owner ? ownFooter(CONFIDENTIAL, owner) : CONFIDENTIAL),
    fonts: {
      sans: [
        ['/usr/share/fonts/truetype/msttcorefonts/Verdana.ttf', '/usr/share/fonts/truetype/msttcorefonts/Verdana_Bold.ttf'],
        ['/usr/share/fonts/truetype/msttcorefonts/verdana.ttf', '/usr/share/fonts/truetype/msttcorefonts/verdanab.ttf'],
        ['/Library/Fonts/Verdana.ttf', '/Library/Fonts/Verdana Bold.ttf'],
        ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
        ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
      ],
      serif: [
        ['/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf', '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Bold.ttf'],
        ['/usr/share/fonts/truetype/msttcorefonts/times.ttf', '/usr/share/fonts/truetype/msttcorefonts/timesbd.ttf'],
        ['/Library/Fonts/Times New Roman.ttf', '/Library/Fonts/Times New Roman Bold.ttf'],
        ['/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf'],
      ],
      // Bundled Carlito first: Calibri's metrics wherever the app runs.
      agenda: [
        [F('Carlito-Regular.ttf'), F('Carlito-Bold.ttf')],
        ['/usr/share/fonts/truetype/msttcorefonts/Calibri.ttf', '/usr/share/fonts/truetype/msttcorefonts/Calibri_Bold.ttf'],
        ['/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf', '/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf'],
        ['/Library/Fonts/Calibri.ttf', '/Library/Fonts/Calibri Bold.ttf'],
        ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
        ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
      ],
    },
  },
};
