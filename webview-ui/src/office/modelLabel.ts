/**
 * Shorten a raw Claude model id into a compact label for the office overlay.
 * "claude-opus-4-8" -> "opus 4.8", "claude-sonnet-5" -> "sonnet 5",
 * "claude-haiku-4-5-20251001" -> "haiku 4.5". Unrecognized shapes pass through.
 */
export function shortenModelName(model: string): string {
  if (!model) return model;
  let s = model.startsWith('claude-') ? model.slice('claude-'.length) : model;
  // Drop a trailing -YYYYMMDD date segment.
  s = s.replace(/-\d{8}$/, '');
  const m = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return model;
  const [, name, major, minor] = m;
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`;
}
