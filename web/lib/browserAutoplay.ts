import { isUncachedDebridStream } from './debrid';
import { playbackPlan } from './streamCompatibility';
import { sourcePickerScore } from './sourceRank';
import type { StreamSource } from './types';

/**
 * Resolution as autoplay sees it. Browsers struggle with 4K (HEVC, Dolby Vision, huge
 * bitrates), and SD looks poor, so the web app only autoplays HD: 1080p first, then 720p.
 * Anything else can still be picked by hand from Sources.
 */
export function autoplayResolution(stream: StreamSource): 'fhd' | 'hd' | 'other' {
  const text = `${stream.quality ?? ''} ${stream.source ?? ''} ${stream.description ?? ''}`.toLowerCase();
  if (/4320|\b8k\b|2160|\b4k\b|\buhd\b|1440/.test(text)) return 'other';
  if (/1080/.test(text)) return 'fhd';
  if (/720/.test(text)) return 'hd';
  return 'other';
}

/** Browser-playable, cached, HD sources for autoplay; best first. */
export function browserAutoplayCandidates(streams: StreamSource[], excluded = new Set<string>()) {
  const seen = new Set<string>();
  const methodRank = { direct: 0, remux: 1, transcode: 2 };
  const resRank = { fhd: 0, hd: 1, other: 2 };
  return streams.filter(s => {
    const url = s.originalUrl ?? s.url;
    if (!s.url || !url || seen.has(url) || excluded.has(url) || isUncachedDebridStream(s) || playbackPlan(s).route !== 'here') return false;
    if (autoplayResolution(s) === 'other') return false;
    seen.add(url); return true;
  }).sort((a,b) =>
    methodRank[playbackPlan(a).method] - methodRank[playbackPlan(b).method]
    || resRank[autoplayResolution(a)] - resRank[autoplayResolution(b)]
    || sourcePickerScore(b,'browser') - sourcePickerScore(a,'browser'));
}
