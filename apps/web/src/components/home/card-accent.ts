import type { CSSProperties } from "react";

// 柔和底色 + 同色系文字，作为没有截图时的首字母卡片底色。
const TINTS: ReadonlyArray<readonly [background: string, ink: string]> = [
  ["#EEF0FF", "#4338CA"], // indigo
  ["#E8F4FD", "#0369A1"], // sky
  ["#E6F6F2", "#0F766E"], // teal
  ["#FDF3E4", "#B45309"], // amber
  ["#FCEEF1", "#BE123C"], // rose
  ["#F3EEFD", "#6D28D9"], // violet
  ["#EDF6E9", "#3F6212"], // lime
  ["#F1F1F4", "#3F3F46"], // zinc
];

// 按项目 id 哈希（FNV-1a）挑一种，相邻 id 也能分散到不同颜色。
export function cardAccentStyle(projectId: string): CSSProperties {
  let hash = 0x811c9dc5;
  for (const character of projectId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const [backgroundColor, color] = TINTS[hash % TINTS.length];
  return { backgroundColor, color };
}
