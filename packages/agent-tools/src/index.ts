/**
 * @gtd/agent-tools — agent 能看到的一切:工具面、时间上下文、权限分级。
 *
 * 按依赖方向分层(barrel 只做转出,不放实现):
 *   readTools / writeTools  ← 纯 domain 调用,不 import SDK
 *   toolCatalog             ← 工具定义(唯一真相:注册 + 权限分级 + 手册同源)
 *   permissionPolicy        ← 只依赖 toolCatalog 的分类,不依赖 Electron(故可单测)
 */
export * from './readTools';
export * from './writeTools';
export * from './timeContext';
export * from './toolCatalog';
export * from './permissionPolicy';
