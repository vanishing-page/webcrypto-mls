// The whole suite, which is what `npm test` and the browser run
// bundle. CI bundles ./unit.js and ./matrix.js separately instead, so
// that the ciphersuite matrix can be split across parallel jobs; a new
// test file goes in whichever of those two it belongs to, and is
// invisible until it does.
import './unit.js'
import './matrix.js'
