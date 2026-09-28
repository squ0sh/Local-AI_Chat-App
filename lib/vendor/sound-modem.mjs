// ESM bridge into the vendored sound modem (UMD, like jsqr). Browsers load
// sound-modem.cjs directly as a classic script, which exposes window.SoundModem.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SoundModem = require('./sound-modem.cjs');

export default SoundModem;
export const encode = SoundModem.encode;
export const decode = SoundModem.decode;
export const decodeAll = SoundModem.decodeAll;
export const decoderText = SoundModem.decoderText;
export const SAMPLE_RATE = SoundModem.SAMPLE_RATE;