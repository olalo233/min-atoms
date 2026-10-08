// Preview hosts are `ma-<8 random chars>.expii.top` (architecture.md §3). The
// labels come from the preview_hosts pool and never carry the domain themselves.
const PREVIEW_DOMAIN = "expii.top";

export function previewUrlForLabel(label: string): string {
  return `https://${label}.${PREVIEW_DOMAIN}`;
}
