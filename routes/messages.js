// AOTC Track — in-app messaging (DMs + group threads).
// A conversation is either a 2-person DM or a 3+ person group. Messages are
// polled by the client (no websockets); every new message also fires a push
// notification that deep-links straight into the conversation.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth } = require('../middleware/auth');
const push = require('../utils/push');

function me(req) { return db.findById('users', req.user.id) || { id: req.user.id, name: 'Unknown' }; }
function userLabel(u) {
  if (!u) return { id: 0, name: 'Unknown', sub: '' };
  const sub = u.entity && u.entity.name ? u.entity.name
    : (u.role === 'admin' ? 'Administrator' : (u.role === 'localadmin' ? 'Local admin' : ''));
  return { id: u.id, name: u.name || u.email || 'User', sub };
}
function isMember(conv, userId) { return conv && (conv.memberIds || []).map(Number).includes(Number(userId)); }
function nameOf(id) { const u = db.findById('users', id); return u ? (u.name || u.email || 'User') : 'Someone'; }

function readMarker(convId, userId) {
  return db.findOne('conversation_reads', r => Number(r.conversationId) === Number(convId) && Number(r.userId) === Number(userId));
}
function setRead(convId, userId) {
  const now = new Date().toISOString();
  const existing = readMarker(convId, userId);
  if (existing) db.update('conversation_reads', existing.id, { lastReadAt: now });
  else db.insert('conversation_reads', { conversationId: Number(convId), userId: Number(userId), lastReadAt: now });
}
function unreadCount(conv, userId) {
  const mark = readMarker(conv.id, userId);
  const since = mark ? mark.lastReadAt : '';
  return db.findAll('messages', m => Number(m.conversationId) === Number(conv.id)
    && Number(m.fromUserId) !== Number(userId)
    && (m.createdAt || '') > since).length;
}
// Display info for a conversation from one user's point of view.
function convView(conv, userId) {
  const others = (conv.memberIds || []).filter(id => Number(id) !== Number(userId));
  const title = conv.type === 'group'
    ? (conv.title || 'Group')
    : nameOf(others[0]);
  return {
    id: conv.id, type: conv.type, title,
    memberNames: (conv.memberIds || []).map(nameOf),
    lastText: conv.lastText || '', lastFrom: conv.lastFrom || '',
    lastMessageAt: conv.lastMessageAt || conv.createdAt,
    unread: unreadCount(conv, userId),
  };
}

// People you can message (everyone but yourself).
router.get('/users', requireAuth, (req, res) => {
  const list = activeUsers(u => Number(u.id) !== Number(req.user.id))
    .map(userLabel)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
});

// My conversations, most recent activity first.
router.get('/conversations', requireAuth, (req, res) => {
  const mine = db.findAll('conversations', c => isMember(c, req.user.id))
    .map(c => convView(c, req.user.id))
    .sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
  res.json(mine);
});

// Create (or, for a DM, reuse) a conversation.
router.post('/conversations', requireAuth, (req, res) => {
  const { type } = req.body;
  if (type === 'group') {
    const ids = [...new Set([Number(req.user.id), ...((req.body.memberIds || []).map(Number))])].filter(n => n > 0);
    if (ids.length < 2) return res.status(400).json({ error: 'Pick at least one person for the group.' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Give the group a name.' });
    const rec = db.insert('conversations', {
      type: 'group', title, memberIds: ids, createdBy: req.user.id,
      lastMessageAt: new Date().toISOString(), lastText: '', lastFrom: '',
    });
    return res.json(convView(rec, req.user.id));
  }
  // DM: find existing 2-person conversation, else create.
  const other = Number(req.body.userId);
  if (!other || other === Number(req.user.id) || !db.findById('users', other)) {
    return res.status(400).json({ error: 'Choose a valid person to message.' });
  }
  const pair = [Number(req.user.id), other].sort((a, b) => a - b);
  let conv = db.findOne('conversations', c => c.type === 'dm'
    && (c.memberIds || []).length === 2
    && [...c.memberIds].map(Number).sort((a, b) => a - b).join(',') === pair.join(','));
  if (!conv) {
    conv = db.insert('conversations', {
      type: 'dm', title: '', memberIds: pair, createdBy: req.user.id,
      lastMessageAt: new Date().toISOString(), lastText: '', lastFrom: '',
    });
  }
  res.json(convView(conv, req.user.id));
});

// One conversation + its messages (also marks it read for me).
router.get('/conversations/:id', requireAuth, (req, res) => {
  const conv = db.findById('conversations', Number(req.params.id));
  if (!conv || !isMember(conv, req.user.id)) return res.status(404).json({ error: 'Conversation not found.' });
  const msgs = db.findAll('messages', m => Number(m.conversationId) === conv.id)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .slice(-200)
    .map(m => ({ id: m.id, fromUserId: m.fromUserId, fromName: m.fromName, text: m.text, createdAt: m.createdAt, mine: Number(m.fromUserId) === Number(req.user.id) }));
  setRead(conv.id, req.user.id);
  res.json({ conversation: convView(conv, req.user.id), messages: msgs });
});

// Send a message.
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conv = db.findById('conversations', Number(req.params.id));
  if (!conv || !isMember(conv, req.user.id)) return res.status(404).json({ error: 'Conversation not found.' });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  if (text.length > 4000) return res.status(400).json({ error: 'Message is too long.' });
  const fromName = me(req).name;
  const rec = db.insert('messages', { conversationId: conv.id, fromUserId: req.user.id, fromName, text, createdAt: new Date().toISOString() });
  db.update('conversations', conv.id, { lastMessageAt: rec.createdAt, lastText: text.slice(0, 120), lastFrom: fromName });
  setRead(conv.id, req.user.id); // sender has "read" their own message
  // Notify the other members (push → deep-links into this conversation).
  const others = (conv.memberIds || []).filter(id => Number(id) !== Number(req.user.id));
  const convTitle = conv.type === 'group' ? (conv.title || 'Group') : fromName;
  const body = conv.type === 'group' ? `${fromName}: ${text.slice(0, 100)}` : text.slice(0, 120);
  try { await push.sendPushToUsers(others, { title: convTitle, body, url: `/messages.html?c=${conv.id}` }); } catch (e) {}
  res.json({ id: rec.id, fromUserId: rec.fromUserId, fromName, text, createdAt: rec.createdAt, mine: true });
});

// Mark a conversation read.
router.post('/conversations/:id/read', requireAuth, (req, res) => {
  const conv = db.findById('conversations', Number(req.params.id));
  if (!conv || !isMember(conv, req.user.id)) return res.status(404).json({ error: 'Conversation not found.' });
  setRead(conv.id, req.user.id);
  res.json({ ok: true });
});

// Total unread across all my conversations (for the nav badge).
router.get('/unread', requireAuth, (req, res) => {
  const total = db.findAll('conversations', c => isMember(c, req.user.id))
    .reduce((sum, c) => sum + unreadCount(c, req.user.id), 0);
  res.json({ count: total });
});

module.exports = router;
