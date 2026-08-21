import type { EpisodeRecord } from "./db.ts";
import type { AiApiFormat, AiProvider } from "./ai-provider.ts";

export const ANALYSIS_MODEL = "deepseek-v4-flash";
export type AnalysisKind = "summary" | "learning_prompt";
export type AnalysisSource = "original" | "current";

const SINGLE_PASS_CHARS = 180_000;
const CHUNK_CHARS = 50_000;

function charLength(value: string): number {
  return Array.from(value).length;
}

export function splitForAnalysis(markdown: string): string[] {
  if (charLength(markdown) <= SINGLE_PASS_CHARS) return [markdown];
  const paragraphs = markdown.replace(/\r/g, "").split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (charLength(paragraph) > CHUNK_CHARS) {
      if (current) chunks.push(current);
      const characters = Array.from(paragraph);
      for (let index = 0; index < characters.length; index += CHUNK_CHARS) {
        chunks.push(characters.slice(index, index + CHUNK_CHARS).join(""));
      }
      current = "";
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (charLength(candidate) > CHUNK_CHARS) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function yaml(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

export function buildAnalysisMarkdown(args: {
  episode: EpisodeRecord;
  kind: AnalysisKind;
  sourceType: AnalysisSource;
  sourceHash: string;
  generatedAt: string;
  body: string;
  provider: AiProvider;
  apiFormat: AiApiFormat;
  model: string;
  frameworkId?: string | null;
  frameworkName?: string | null;
}): string {
  const title = args.kind === "summary"
    ? `${args.episode.title}｜内容梳理`
    : `${args.episode.title}｜深度学习与实践 Prompt`;
  return `---
source: "xiaoyuzhou"
episode_id: ${yaml(args.episode.eid)}
podcast: ${yaml(args.episode.podcast_title)}
title: ${yaml(args.episode.title)}
result_type: ${yaml(args.kind)}
framework_id: ${yaml(args.frameworkId ?? null)}
framework_name: ${yaml(args.frameworkName ?? null)}
analysis_source: ${yaml(args.sourceType)}
source_hash: ${yaml(args.sourceHash)}
provider: ${yaml(args.provider)}
api_format: ${yaml(args.apiFormat)}
model: ${yaml(args.model)}
generated_at: ${yaml(args.generatedAt)}
---

# ${title}

${args.body.trim()}
`;
}
