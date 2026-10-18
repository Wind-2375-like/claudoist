/** VSCode 式相对时间:刚刚 / 12m / 3h / 2d / 超过一周给日期 */
export function relTime(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${String(min)}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${String(h)}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${String(d)}d`;
  return iso.slice(5, 10);
}
