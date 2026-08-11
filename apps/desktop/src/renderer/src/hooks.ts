import { keepPreviousData, useQuery } from '@tanstack/react-query';

export function useInbox() {
  return useQuery({ queryKey: ['inbox'], queryFn: () => window.gtd.inboxList() });
}

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => window.gtd.projectsList() });
}

export function useProjectView(id: string) {
  return useQuery({ queryKey: ['project', id], queryFn: () => window.gtd.projectView(id) });
}

export function useTaskDetail(id: string) {
  return useQuery({ queryKey: ['taskDetail', id], queryFn: () => window.gtd.taskDetail(id) });
}

export function useToday() {
  return useQuery({ queryKey: ['today'], queryFn: () => window.gtd.today() });
}

/** 日历区间(D-23/INV-28/M6b):from 起 days 天;写操作后由全局 invalidate 刷新。 */
export function useCalendarRange(from: string, days: number) {
  return useQuery({
    queryKey: ['calendar', from, days],
    queryFn: () => window.gtd.calendarRange(from, days),
    // 切周时保留上一周数据直到新数据到达,避免整张网格闪空
    placeholderData: keepPreviousData,
  });
}

/** Google 连接状态(M6c-1)。 */
export function useGoogleStatus() {
  return useQuery({ queryKey: ['google', 'status'], queryFn: () => window.google.status() });
}

/** Google 日历列表;仅在已连接时请求。 */
export function useGoogleCalendars(enabled: boolean) {
  return useQuery({
    queryKey: ['google', 'calendars'],
    queryFn: () => window.google.calendars(),
    enabled,
  });
}

/**
 * 拉取窗口内的 Google 事件并镜像成本地任务(D-25)。写操作会触发全局 invalidate,
 * 镜像出的任务随即出现在 Today/Calendar —— 因此这里不返回数据,只负责"看到就同步"。
 */
export function useGoogleSync(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: ['google', 'sync', from, to],
    queryFn: () => window.google.sync(from, to),
    enabled,
    // 后台每分钟拉一次(Google 不支持桌面端 push,只能轮询;配额限 600 次/分钟/用户)
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // 本地每次写都会 invalidate 全部查询;没有 staleTime 的话,连点几下任务就会把
    // 同步请求放大到每秒一轮(评审 HIGH:请求量随用户操作频率放大)
    staleTime: 55_000,
  });
}

/** 外部日历镜像任务容器(D-25)。 */
export function useUpstream() {
  return useQuery({ queryKey: ['upstream'], queryFn: () => window.gtd.upstreamList() });
}

/** ⌘K 搜索(M7a):空查询不发请求;keepPreviousData 让逐字输入时列表不闪。 */
export function useSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ['search', q],
    queryFn: () => window.gtd.search(q),
    enabled: q !== '',
    placeholderData: (prev) => prev,
  });
}

export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: () => window.gtd.labelsList() });
}

export function useFilters() {
  return useQuery({ queryKey: ['filters'], queryFn: () => window.gtd.filtersList() });
}

/** 求值一条查询;空查询不请求。 */
export function useFilterRun(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ['filterRun', q],
    queryFn: () => window.gtd.filterRun(q),
    enabled: q !== '',
    placeholderData: (prev) => prev,
  });
}

export function useBucket(kind: 'someday' | 'reference') {
  return useQuery({ queryKey: ['bucket', kind], queryFn: () => window.gtd.bucketList(kind) });
}

export function useBucketCounts() {
  return useQuery({ queryKey: ['bucketCounts'], queryFn: () => window.gtd.bucketCounts() });
}

export function useCompleted() {
  return useQuery({ queryKey: ['completed'], queryFn: () => window.gtd.completedList() });
}
