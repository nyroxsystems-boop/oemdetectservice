const SESSION_CONTINUATION_PATTERNS = [
  /\bin\s+dieser\s+(?:sitzung|session)\s+(?:fortfahren|fortsetzen|weiter(?:machen)?)\b/i,
  /\b(?:aktuelle|bestehende)\s+(?:sitzung|session)\s+(?:fortfahren|fortsetzen|weiter(?:machen)?|übernehmen)\b/i,
  /\b(?:sitzung|session)\s+(?:hier\s+)?(?:fortfahren|fortsetzen|weiter(?:machen)?|übernehmen)\b/i,
  /\bcontinue\s+(?:in|with)\s+(?:this|the\s+current)\s+session\b/i,
  /\bresume\s+(?:this|the\s+current)\s+session\b/i,
];

export function isPartslinkSessionContinuationLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, ' ').trim();
  return SESSION_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized));
}
