// Deterministic fake conversation used by the server's mock provider and by the static demo
// build (which has no speech-to-text service).

export interface MockSegment {
  /** Raw speaker label: "A", "B", … */
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

const SENTENCES = [
  'Thanks for joining me today.',
  'Happy to be here.',
  'Let’s start with how the project began.',
  'It started as a small experiment on a weekend.',
  'We wanted to see whether the idea could work at all.',
  'What surprised you the most in the early days?',
  'Honestly, how quickly people started using it.',
  'We had to rewrite the backend twice in the first month.',
  'That sounds stressful.',
  'It was, but it taught us a lot about planning.',
  'How did you decide what to build next?',
  'We listened to the people who used it every day.',
  'Their feedback shaped almost every feature.',
  'Can you give an example?',
  'Sure, the export feature came straight from a user request.',
  'Where do you see it going from here?',
  'We want to make it faster and easier to share.',
  'And of course to support more languages.',
  'That’s a great place to wrap up.',
  'Thank you so much for your time.',
];

/** Small deterministic PRNG so the same input always gives the same transcript. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Segments spanning `durationSec`, alternating between `speakerCount` speakers. Speakers
 * sometimes keep talking for several segments in a row, which exercises row merging.
 */
export function generateMockSegments(durationSec: number, speakerCount: number, seed: number): MockSegment[] {
  const random = mulberry32(seed);
  const totalMs = Math.max(1000, Math.round(durationSec * 1000));
  const speakers = Math.max(1, Math.min(26, Math.trunc(speakerCount)));
  const segments: MockSegment[] = [];
  let t = Math.min(400, totalMs / 10);
  let speaker = 0;
  let i = 0;
  while (t < totalMs - 200) {
    const text = SENTENCES[i % SENTENCES.length]!;
    const wordCount = text.split(' ').length;
    const length = Math.min(totalMs - t, Math.round(wordCount * (320 + random() * 120)));
    segments.push({
      speaker: String.fromCharCode(65 + speaker),
      startMs: Math.round(t),
      endMs: Math.round(t + length),
      text,
    });
    t += length + 150 + random() * 450;
    i++;
    if (speakers > 1 && random() > 0.35)
      speaker = (speaker + 1 + Math.floor(random() * (speakers - 1))) % speakers;
  }
  return segments;
}
