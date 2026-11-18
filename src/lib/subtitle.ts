export type SubtitleFormat = 'srt' | 'ass' | 'ssa' | 'vtt';

export function subtitleFormatOf(filename: string): SubtitleFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext === 'srt' || ext === 'ass' || ext === 'ssa' || ext === 'vtt' ? ext : null;
}

/** UTF-8 优先；替换字符过多时按常见中文字幕编码 GB18030 重试。 */
export function decodeSubtitleBytes(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const replacements = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacements <= Math.max(1, utf8.length / 500)) return utf8;
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return utf8;
  }
}

function normalizeTimestamp(raw: string): string {
  const value = raw.trim().replace(',', '.');
  const parts = value.split(':');
  if (parts.length === 2) parts.unshift('00');
  const [hours = '00', minutes = '00', seconds = '00'] = parts;
  const [sec = '00', fraction = '000'] = seconds.split('.');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${sec.padStart(2, '0')}.${fraction.padEnd(3, '0').slice(0, 3)}`;
}

function stripAssTags(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N|\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

function srtToVtt(input: string): string {
  const body = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})/g,
      (_match, sh, sm, eh, em) => `${normalizeTimestamp(`${sh}.${sm}`)} --> ${normalizeTimestamp(`${eh}.${em}`)}`
    );
  return `WEBVTT\n\n${body.trim()}\n`;
}

function assToVtt(input: string): string {
  const cues: string[] = [];
  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    if (!/^Dialogue:/i.test(line)) continue;
    const fields = line.replace(/^Dialogue:\s*/i, '').split(',');
    if (fields.length < 10) continue;
    const start = fields[1];
    const end = fields[2];
    const text = stripAssTags(fields.slice(9).join(','));
    if (!start || !end || !text) continue;
    cues.push(`${normalizeTimestamp(start)} --> ${normalizeTimestamp(end)}\n${text}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function subtitleToVtt(input: string, format: SubtitleFormat): string {
  if (format === 'vtt') {
    const clean = input.replace(/^\uFEFF/, '').trim();
    return /^WEBVTT/i.test(clean) ? `${clean}\n` : `WEBVTT\n\n${clean}\n`;
  }
  if (format === 'srt') return srtToVtt(input);
  return assToVtt(input);
}
