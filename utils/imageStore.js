// Shared helpers for saving product-image files under public/uploads.
// Split out of routes/products.js so routes/procurement.js (saving a photo
// extracted from a supplier invoice, not uploaded via a form file input) can
// reuse the exact same extension-safety logic rather than duplicating it.
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Map a validated image mimetype to a safe extension. The extension is
// derived from a mimetype WE validated — never from any attacker/user-
// controlled filename — otherwise a mismatched mimetype/extension could get
// saved as e.g. .html/.svg and served by express.static as active content
// (stored XSS on our own origin).
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function randomFilename(mimetype) {
  const ext = MIME_EXT[mimetype] || '.jpg';
  return `item-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
}

// Decode a "data:image/png;base64,...." URL and write it to public/uploads.
// Returns the public "/uploads/xxx" path, or null if the input isn't a
// recognised, reasonably-sized image data URL (caller decides what "invalid"
// means for its own flow — this never throws).
function saveBase64Image(dataUrl, maxBytes = 3 * 1024 * 1024) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([a-zA-Z0-9+/=]+)$/);
  if (!m) return null;
  const [, mimetype, b64] = m;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > maxBytes) return null;
  const filename = randomFilename(mimetype);
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return `/uploads/${filename}`;
}

// ---- Member photos (PRIVATE) ----
// Member face photos are sensitive, so they are NOT written to public/uploads
// (which express.static serves openly by URL). They live under data/ with an
// unguessable filename and are only served through an auth-gated route.
const MEMBER_PHOTO_DIR = path.join(__dirname, '..', 'data', 'member-photos');
if (!fs.existsSync(MEMBER_PHOTO_DIR)) fs.mkdirSync(MEMBER_PHOTO_DIR, { recursive: true });

const crypto = require('crypto');
// Save a base64 data-URL photo privately; returns the bare filename (stored on
// the member record), or null if it isn't a valid, reasonably-sized image.
function saveMemberPhoto(dataUrl, maxBytes = 2 * 1024 * 1024) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/);
  if (!m) return null;
  const [, mimetype, b64] = m;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > maxBytes) return null;
  const ext = MIME_EXT[mimetype] || '.jpg';
  const filename = `m-${crypto.randomBytes(12).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(MEMBER_PHOTO_DIR, filename), buf);
  return filename;
}
function memberPhotoPath(filename) {
  if (!filename || /[\\/]/.test(filename)) return null; // no path traversal
  const p = path.join(MEMBER_PHOTO_DIR, filename);
  return fs.existsSync(p) ? p : null;
}
function deleteMemberPhoto(filename) {
  const p = memberPhotoPath(filename);
  if (p) { try { fs.unlinkSync(p); } catch (e) {} }
}

module.exports = {
  UPLOAD_DIR, MIME_EXT, randomFilename, saveBase64Image,
  MEMBER_PHOTO_DIR, saveMemberPhoto, memberPhotoPath, deleteMemberPhoto,
};
