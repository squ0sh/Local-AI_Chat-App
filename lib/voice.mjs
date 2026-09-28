// Shared offline-voice helpers (server tests + capsule-ui.js twin).
// capsule-ui.js keeps a classic-script duplicate — keep both in sync.

// Trim filler while preserving the meaning of the line (STT transcripts).
export function cleanSpeechText(text) {
  let t = String(text || '').trim();
  do { const before = t; t = t.replace(/^(?:hey|okay|ok|so|um|uh|hmm|alright|right|yeah|no problem)\b[,\s]+/i, ''); if (t === before) break; } while (true);
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

// Split a transcript into one-shot speech commands: whole line when short,
// otherwise clause-ish buckets no longer than `max`.
export function speechChunks(text, max = 320) {
  const clean = cleanSpeechText(text);
  const fall = String(text || '').trim().replace(/\s+/g, ' ');
  const src = clean || fall;
  if (!src) return [];
  if (src.length <= max) return [src];
  const out = [];
  const parts = src.split(/(?<=[.!?])\s+/);
  let buf = '';
  bufferParts(parts.length === 1 ? chunkRaw(src, max) : parts);
  return out;

  function bufferParts(list) {
    for (const part of list) {
      if (part.length > max) {
        if (buf) out.push(buf);
        buf = '';
        for (const piece of chunkRaw(part, max)) out.push(piece);
        continue;
      }
      if (buf && buf.length + 1 + part.length > max) {
        out.push(buf);
        buf = part;
      } else {
        buf = buf ? buf + ' ' + part : part;
      }
    }
    if (buf) out.push(buf);
  }
}

function chunkRaw(s, max) {
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

// True when an utterance says yes / asks to proceed.
export function isYesWord(w) {
  return /^(yes|yeah|yep|y|ok|okay|okay|sure|fine|go ahead|go|please|please do|do it|approve|sounds good|sounds great|that'?s great|that'?s fine|that'?s good|confirm|continue)$/i.test(String(w || '').trim());
}

// True when an utterance refuses / defers.
export function isNoWord(w) {
  return /^(no|nope|n|nah|cancel|skip|stop|not now|later|don'?t|never|decline|ignore|not yet|hold off|no thanks)$/i.test(String(w || '').trim());
}

// Extract the decision from a transcript: 'yes' | 'no' | null.
export function speechDecision(text) {
  const t = cleanSpeechText(text);
  if (!t) return null;
  if (isYesWord(t)) return 'yes';
if (isNoWord(t)) return 'no';
  const m = t.match(/^(please (?:do it|go ahead|proceed)|i (?:approve|agree|accept|say yes)|yes please|sounds good|that'?s (?:fine|good|right|correct|ok(?:ay)?))$/i);
  if (m) return 'yes';
  const n = t.match(/^(i (?:decline|refuse|say no)|no (?:thank you|thanks)|not (?:now|yet)|honor(?: the)? defer(?:ral)?|hold off|cancel (?:it|that)|stop(?: for now)?|don'?t (?:do it|proceed|bother)|skip it|later(?: for now)?)$/i);
  if (n) return 'no';
  return null;
}

// Split streaming LLM text into sentence-ish chunks to speak immediately.
export function liveSpeechChunks(text, max = 300) {
  const clean = cleanSpeechText(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out = [];
  const parts = clean.split(/(?<=[.!?;:])\s+/);
  let buf = '';
  for (const part of parts) {
    if (part.length > max) {
      if (buf) out.push(buf);
      buf = '';
      out.push(part.slice(0, max));
    } else {
      buf = buf ? buf + ' ' + part : part;
    }
  }
  if (buf) out.push(buf);
  return out;
}