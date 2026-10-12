/**
 * What Whisper writes down for noise with no speech in it (#89): the credits
 * of the subtitles it learnt Russian from, and sounds in brackets. Its own
 * guess that nothing was said is no help here, so these are taken out by
 * sight. The credits come last, so everything from them on goes.
 */
const NOT_SPEECH = [
  /\[[^\]]*\]/g,
  /\([^)]*\)/g,
  /(редактор|корректор)\s+субтитров.*$/gis,
  /субтитры\s+(сделал|создавал|подготовил|делал).*$/gis,
  /продолжение следует[.!…]*/gi,
  /спасибо за просмотр[.!…]*/gi,
  /dimatorzok/gi,
];

/** Whisper's text with what it makes up for noise taken out; empty when nothing else is left. */
export function speechOnly(text: string): string {
  let left = text;
  for (const pattern of NOT_SPEECH) left = left.replace(pattern, " ");
  left = left.replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(left) ? left : "";
}
