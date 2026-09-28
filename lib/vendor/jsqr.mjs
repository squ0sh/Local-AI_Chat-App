// ESM bridge into the vendored UMD build. The raw dist hangs off the webpack
// module object as `.default`; browsers load jsqr-core.cjs directly as a
// classic script, which hands the same object to window.jsQR instead.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsQR = require('./jsqr-core.cjs').default;

export default jsQR;