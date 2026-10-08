import type { CSSProperties } from "react";

// 按项目 id 哈希出一种柔和色，作为没有截图时的首字母卡片底色。
export function cardAccentStyle(projectId: string): CSSProperties {
  let hash = 0;
  for (const character of projectId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return {
    backgroundColor: `hsl(${hue} 65% 93%)`,
    color: `hsl(${hue} 45% 38%)`,
  };
}
