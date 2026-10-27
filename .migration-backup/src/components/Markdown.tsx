"use client";

import { useMemo } from "react";

import { renderMarkdown } from "@/lib/markdown";

// The renderer lives in @/lib/markdown (pure, allowlisted, unit-tested);
// this component only binds it to React. Security notes: src/lib/markdown.ts.
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
