export function removeAciiColors(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[\d+m/g, '');
}
