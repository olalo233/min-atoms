import { useMemo, type ReactNode } from "react";

/**
 * Minimal Markdown renderer for run bodies (ux §6.2): paragraphs, unordered
 * and ordered lists, fenced code blocks, inline code, and bold. Never uses
 * dangerouslySetInnerHTML, so raw event text cannot inject markup.
 */

type Block =
  | { type: "code"; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; lines: string[] };

const LIST_LINE = /^\s*(?:[-*+]|(\d{1,2})[.)])\s+(.*)$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ type: "code", content: buffer.join("\n") });
      continue;
    }
    if (LIST_LINE.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const match = LIST_LINE.exec(lines[i]);
        if (!match) break;
        items.push(match[2]);
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("```") && !LIST_LINE.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  text.split(/(`[^`\n]+`)/g).forEach((segment, i) => {
    if (segment.length > 2 && segment.startsWith("`") && segment.endsWith("`")) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded border border-zinc-200 bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] break-all"
        >
          {segment.slice(1, -1)}
        </code>,
      );
      return;
    }
    segment.split(/(\*\*[^*\n]+\*\*)/g).forEach((part, j) => {
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
        nodes.push(
          <strong key={`${keyPrefix}-b${i}-${j}`} className="font-semibold">
            {part.slice(2, -2)}
          </strong>,
        );
      } else if (part) {
        nodes.push(part);
      }
    });
  });
  return nodes;
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (blocks.length === 0 && !streaming) return null;
  return (
    <div className="space-y-2 text-[15px] leading-[1.6] text-zinc-800">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre key={index} className="overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-700">
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "list") {
          const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `${index}-${itemIndex}`)}</li>);
          return block.ordered ? (
            <ol key={index} className="list-decimal space-y-1 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {items}
            </ul>
          );
        }
        return (
          <p key={index}>
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line, `${index}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
      {streaming && <span className="wb-cursor text-indigo-600">▍</span>}
    </div>
  );
}
