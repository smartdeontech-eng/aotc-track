// How groups are ordered everywhere they are listed.
//
// Not alphabetically. The congregation's groups follow the generational path a
// member walks through the church — Children's Service, Junior Youth, Young
// People's Guild, Young Adults' Fellowship, then the Men's and Women's
// Fellowships — and a list that opens with "Bible Study and Prayer Group, Blue
// Cross, Boys and Girls Brigade" reads as noise to anyone who knows the church.
// So: the generational groups first, in their own order, then every other group
// alphabetically.
//
// Matched on CODE, not name, so renaming a group ("Junior Youth Fellowship" →
// "Junior Youth") never silently drops it to the bottom of the list. A code that
// is not listed here sorts into the alphabetical tail, so adding a new group
// needs no change to this file.
const GENERATIONAL_ORDER = ['CS', 'JY', 'YPG', 'YAF', 'MF', 'WF'];

function groupRank(g) {
  const i = GENERATIONAL_ORDER.indexOf(g && g.code);
  return i === -1 ? GENERATIONAL_ORDER.length : i;
}

// Returns a NEW array — never sorts the caller's list in place.
function sortGroups(list) {
  return (list || []).slice().sort((a, b) =>
    groupRank(a) - groupRank(b) || String(a.name || '').localeCompare(String(b.name || '')));
}

module.exports = { GENERATIONAL_ORDER, groupRank, sortGroups };
