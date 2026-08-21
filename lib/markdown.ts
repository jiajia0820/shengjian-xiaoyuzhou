import type { OfficialEpisode, TranscriptSegment } from "./xiaoyuzhou";

const entityMap: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entityMap[entity.toLowerCase()] ?? match;
  });
}

export function shownotesToMarkdown(html: string): string {
  if (!html.trim()) return "_本期暂无 Show Notes。_";
  return decodeEntities(html)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|section|h[1-6]|blockquote)\s*>/gi, "\n\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatTimestamp(startMs: number): string {
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remaining = (seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remaining}`;
}

function yaml(value: string | null | number): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function buildMarkdown(
  episode: OfficialEpisode,
  sourceUrl: string,
  segments: TranscriptSegment[],
  fetchedAt = new Date().toISOString(),
): string {
  const transcript = segments.map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.text}`).join("\n\n");
  return `---
source: "xiaoyuzhou"
source_url: ${yaml(sourceUrl)}
episode_id: ${yaml(episode.eid)}
podcast: ${yaml(episode.podcastTitle)}
title: ${yaml(episode.title)}
published_at: ${yaml(episode.publishedAt)}
duration_seconds: ${yaml(episode.durationSeconds)}
fetched_at: ${yaml(fetchedAt)}
segment_count: ${segments.length}
---

# ${episode.title}

> 节目：${episode.podcastTitle}  
> 原始单集：[在小宇宙查看](${sourceUrl})

## Show Notes

${shownotesToMarkdown(episode.shownotesHtml)}

## 官方文稿

${transcript}
`;
}
