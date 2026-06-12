// 开发模式下 Vite 跑在 5173、API 跑在 8787；生产（Docker）里 Hono 同源
// 提供静态文件和 /api，所以用相对路径。VITE_API_BASE 可强制覆盖。
export const apiBase = import.meta.env.VITE_API_BASE
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
