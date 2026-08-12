/**
 * 键盘事件的共用判定。
 *
 * ## 为什么要有这个文件
 *
 * 2026-08-12 用户反馈:「给 project 命名的时候用中文输入法输入英文,回车之后直接保存了,
 * 应该只是把英文输入进去。」
 *
 * 这是 IME(输入法)的组字态问题。中文输入法在拼字期间,输入框里是**未上屏的候选文本**,
 * 此时按回车的语义是「就用我打的这串字母,别转成汉字」—— 也就是**上屏**,不是提交表单。
 * 但浏览器在组字期间同样会派发 `keydown`,`e.key` 就是 `'Enter'`,于是表单把它当成了提交:
 * 用户还没打完就被存下来了,而且存进去的往往是半截内容。
 *
 * 标准判据是 `KeyboardEvent.isComposing` —— 组字期间为 true。React 的合成事件不透出这个
 * 字段,必须从 `nativeEvent` 上取。另外补一条 `keyCode === 229` 的兜底:部分输入法
 * (以及旧版 WebKit)在组字期间只给这个魔数、不设 isComposing。
 *
 * 这个 bug 全应用 12 处 Enter 提交点**一处都没防**,所以收成一个函数,而不是各处 inline 判断
 * —— inline 写法必然会在下一个新表单里被忘掉。
 */

type AnyKeyEvent = { key: string; nativeEvent: unknown };

/** 组字进行中?(输入法候选还没上屏) */
export function isComposing(e: AnyKeyEvent): boolean {
  const n = e.nativeEvent as { isComposing?: boolean; keyCode?: number } | null;
  return n?.isComposing === true || n?.keyCode === 229;
}

/**
 * 这次回车是「提交」吗?
 *
 * 组字期间一律返回 false —— 那个回车属于输入法,不属于我们。
 */
export function isSubmitEnter(e: AnyKeyEvent): boolean {
  return e.key === 'Enter' && !isComposing(e);
}
