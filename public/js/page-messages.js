// Messages page — 1-to-1 and group chat. Polls for new messages (no websockets
// in the stack); new messages also arrive as deep-linking push notifications.
let meUser, users = [], convs = [], activeId = null, poll = null;

function fmtTime(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d >= today
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

async function loadConvs() {
  try { convs = await api('/messages/conversations'); } catch (e) { return; }
  const list = document.getElementById('convList');
  list.innerHTML = convs.length ? convs.map(c => `
    <button type="button" class="conv-item${c.id === activeId ? ' active' : ''}" data-id="${c.id}">
      <div class="conv-top">
        <span class="conv-name">${c.type === 'group' ? '👥 ' : ''}${esc(c.title)}</span>
        <span class="conv-time">${c.lastMessageAt ? fmtTime(c.lastMessageAt) : ''}</span>
      </div>
      <div class="conv-last">${esc(c.lastText || 'No messages yet')}${c.unread ? `<span class="conv-unread">${c.unread}</span>` : ''}</div>
    </button>`).join('') : '<p class="sub" style="padding:16px;">No conversations yet. Tap “New message”.</p>';
  list.querySelectorAll('.conv-item').forEach(el => el.onclick = () => openConv(Number(el.dataset.id)));
}

async function openConv(id, { push: pushState = true } = {}) {
  activeId = id;
  let data;
  try { data = await api(`/messages/conversations/${id}`); } catch (e) { toast(e.message, true); return; }
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('chatHead').style.display = '';
  document.getElementById('chatMsgs').style.display = '';
  document.getElementById('chatComposer').style.display = '';
  document.getElementById('chatTitle').textContent = data.conversation.type === 'group'
    ? `${data.conversation.title} · ${data.conversation.memberNames.length} people`
    : data.conversation.title;
  const isGroup = data.conversation.type === 'group';
  const box = document.getElementById('chatMsgs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = data.messages.map(m => `
    <div class="msg-row ${m.mine ? 'mine' : 'theirs'}">
      <div class="msg-bubble">
        ${!m.mine && isGroup ? `<div class="msg-from">${esc(m.fromName)}</div>` : ''}
        <div class="msg-text">${esc(m.text)}</div>
        <div class="msg-time">${fmtTime(m.createdAt)}</div>
      </div>
    </div>`).join('') || '<p class="sub" style="padding:16px; text-align:center;">No messages yet — say hello.</p>';
  if (atBottom || pushState) box.scrollTop = box.scrollHeight;
  document.getElementById('chat').classList.add('thread-open');
  if (pushState) { try { history.replaceState(null, '', `/messages.html?c=${id}`); } catch (e) {} }
  loadConvs(); // refresh unread/order
}

async function sendCurrent(e) {
  e.preventDefault();
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text || !activeId) return;
  input.value = '';
  try {
    await api(`/messages/conversations/${activeId}/messages`, { method: 'POST', body: { text } });
    await openConv(activeId, { push: false });
    const box = document.getElementById('chatMsgs'); box.scrollTop = box.scrollHeight;
  } catch (err) { toast(err.message, true); input.value = text; }
}

// ---- New DM / group ----
function openDm() {
  document.getElementById('dmUser').innerHTML = users.map(u => `<option value="${u.id}">${esc(u.name)}${u.sub ? ' — ' + esc(u.sub) : ''}</option>`).join('')
    || '<option value="">No other users</option>';
  document.getElementById('dmOverlay').style.display = 'flex';
}
async function startDm() {
  const userId = Number(document.getElementById('dmUser').value);
  if (!userId) return;
  try {
    const c = await api('/messages/conversations', { method: 'POST', body: { type: 'dm', userId } });
    document.getElementById('dmOverlay').style.display = 'none';
    await loadConvs(); openConv(c.id);
  } catch (e) { toast(e.message, true); }
}
function openGroup() {
  document.getElementById('grpTitle').value = '';
  document.getElementById('grpPeople').innerHTML = users.map(u => `
    <label class="grp-person"><input type="checkbox" value="${u.id}"> ${esc(u.name)}${u.sub ? ` <span class="sub">— ${esc(u.sub)}</span>` : ''}</label>`).join('')
    || '<p class="sub">No other users.</p>';
  document.getElementById('groupOverlay').style.display = 'flex';
}
async function createGroup() {
  const title = document.getElementById('grpTitle').value.trim();
  const memberIds = [...document.querySelectorAll('#grpPeople input:checked')].map(cb => Number(cb.value));
  if (!title) { toast('Give the group a name.', true); return; }
  if (!memberIds.length) { toast('Pick at least one person.', true); return; }
  try {
    const c = await api('/messages/conversations', { method: 'POST', body: { type: 'group', title, memberIds } });
    document.getElementById('groupOverlay').style.display = 'none';
    await loadConvs(); openConv(c.id);
  } catch (e) { toast(e.message, true); }
}

document.getElementById('newDmBtn').onclick = openDm;
document.getElementById('dmCancel').onclick = () => { document.getElementById('dmOverlay').style.display = 'none'; };
document.getElementById('dmStart').onclick = startDm;
document.getElementById('newGroupBtn').onclick = openGroup;
document.getElementById('grpCancel').onclick = () => { document.getElementById('groupOverlay').style.display = 'none'; };
document.getElementById('grpCreate').onclick = createGroup;
document.getElementById('chatComposer').addEventListener('submit', sendCurrent);
document.getElementById('chatBack').onclick = () => { document.getElementById('chat').classList.remove('thread-open'); activeId = null; };

requireAuthAndRenderShell().then(async u => {
  meUser = u;
  try { users = await api('/messages/users'); } catch (e) { users = []; }
  await loadConvs();
  // Deep link: ?c=<conversation> or ?u=<user to DM>
  const p = new URLSearchParams(location.search);
  if (p.get('c')) openConv(Number(p.get('c')));
  else if (p.get('u')) {
    try { const c = await api('/messages/conversations', { method: 'POST', body: { type: 'dm', userId: Number(p.get('u')) } }); openConv(c.id); } catch (e) {}
  }
  // Poll: refresh the open thread + conversation list.
  poll = setInterval(() => {
    if (activeId) openConv(activeId, { push: false }); else loadConvs();
  }, 9000);
});
window.addEventListener('beforeunload', () => { if (poll) clearInterval(poll); });
