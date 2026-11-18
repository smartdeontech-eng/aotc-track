// ---- WebAuthn / passkey helpers ----
// Thin wrapper around @simplewebauthn/server that (a) figures out the correct
// Relying Party ID + origin for whatever host the app is being served from,
// and (b) re-exports the four verify/generate functions the routes need.
//
// The RP ID must be the site's registrable domain (e.g. "aotc-track.com")
// and the origin the full URL the browser sees (e.g. "https://aotc-track.com").
// In dev that's "localhost" / "http://localhost:3000". We derive both from the
// incoming request so the same code works locally and in production, but allow
// an explicit override via env vars for reverse-proxy setups where the Host
// header or protocol can't be trusted.
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'AOTC Track';

// Work out { rpID, origin } for this request.
// Priority: explicit env overrides -> values derived from the request.
function getRP(req) {
  const envRpId = process.env.WEBAUTHN_RP_ID;
  const envOrigin = process.env.WEBAUTHN_ORIGIN;

  // Host header without the port -> the RP ID.
  const host = (req.get('host') || 'localhost').split(':')[0];
  // req.protocol honours x-forwarded-proto when `trust proxy` is set (it is,
  // in production), so this is https behind nginx and http on localhost.
  const proto = req.protocol || 'http';
  const derivedOrigin = `${proto}://${req.get('host') || 'localhost:3000'}`;

  return {
    rpName: RP_NAME,
    rpID: envRpId || host,
    origin: envOrigin || derivedOrigin,
  };
}

module.exports = {
  getRP,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};
