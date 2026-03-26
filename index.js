// OpenClaw plugin entry point.
// OpenClaw looks for index.js (or index.ts) in the plugin rootDir.
// We delegate to the compiled TypeScript output in dist/.
module.exports = require('./dist/index.js');
