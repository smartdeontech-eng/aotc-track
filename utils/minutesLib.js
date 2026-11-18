// @deontech/minutes, as this app uses it.
//
// Deploys never run npm install (node_modules is shared by the blue and green
// lines — see deploy/bluegreen/common.sh), so a newer version of the library
// would never reach the server through package.json alone. The app therefore
// carries its own copy in lib/deontech-minutes (0.5.1: the "details" line
// under a name in IN ATTENDANCE, and titles that shrink to fit in the PDF) and
// uses it first, falling back to the installed package.
let lib;
try { lib = require('../lib/deontech-minutes'); } catch (e) { lib = require('@deontech/minutes'); }
module.exports = lib;
