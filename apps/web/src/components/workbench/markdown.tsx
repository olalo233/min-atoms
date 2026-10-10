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
          className="rounded-md bg-zinc-100 px-1.5 py-px font-mono text-[0.84em] text-zinc-800 ring-1 ring-zinc-950/[0.06] [overflow-wrap:anywhere]"
        >
          {segment.slice(1, -1)}
        </code>,
      );
      return;
    }
    segment.split(/(\*\*[^*\n]+\*\*)/g).forEach((part, j) => {
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
        nodes.push(
          <strong key={`${keyPrefix}-b${i}-${j}`} className="font-semibold text-zinc-900">
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

const Cursor = () => <span aria-hidden="true" className="wb-cursor" />;

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (blocks.length === 0 && !streaming) return null;
  const lastIndex = blocks.length - 1;
  // The streaming cursor trails the last word; after a code block it gets its own line.
  const inlineCursor = streaming && lastIndex >= 0 && blocks[lastIndex].type !== "code";
  return (
    <div className="min-w-0 space-y-2.5 text-[15px] leading-[1.65] [overflow-wrap:anywhere] text-zinc-800">
      {blocks.map((block, index) => {
        const cursorHere = inlineCursor && index === lastIndex;
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="max-w-full overflow-x-auto rounded-xl bg-zinc-50 px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-zinc-700 ring-1 ring-zinc-950/[0.06] [overflow-wrap:normal]"
            >
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {renderInline(item, `${index}-${itemIndex}`)}
              {cursorHere && itemIndex === block.items.length - 1 && <Cursor />}
            </li>
          ));
          return block.ordered ? (
            <ol key={index} className="list-decimal space-y-1 pl-5 marker:text-zinc-400">
              {items}
            </ol>
          ) : (
            <ul key={index} className="list-disc space-y-1 pl-5 marker:text-zinc-300">
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
            {cursorHere && <Cursor />}
          </p>
        );
      })}
      {streaming && !inlineCursor && (
        <div>
          <Cursor />
        </div>
      )}
    </div>
  );
}
