import axios from 'axios';
import { RELAY_API_URL } from './env';

// ===== 创建 Axios 实例 =====
const api = axios.create({
  baseURL: RELAY_API_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
  // httpOnly cookie 认证（02a-S11）：每次请求自动携带 rb_access/rb_refresh cookie
  withCredentials: true,
});

// ===== 刷新 Access Token（02a-S11）=====
// token 存在 httpOnly cookie 中，服务端读 rb_refresh cookie 后在 Set-Cookie 里
// 写回新的 rb_access，客户端无需手动传递或存储 token 字符串。
// 并发去重：多个 401 同时触发时只发一次刷新请求。
let refreshPromise: Promise<void> | null = null;

export function refreshAccessToken(): Promise<void> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    // withCredentials 自动携带 rb_refresh cookie，无需在 body 传 token
    await axios.post(
      `${api.defaults.baseURL}/auth/refresh`,
      {},
      { withCredentials: true }
    );
    // 服务端已在响应 Set-Cookie 中更新 rb_access，下次请求自动生效
  })();

  refreshPromise.finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ===== 请求拦截器 =====
// token 由 cookie 自动携带，无需手动注入 Authorization 头（02a-S11）
api.interceptors.request.use(
  (config) => config,
  (error) => Promise.reject(error)
);

// ===== 响应拦截器 =====
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        await refreshAccessToken();
        // cookie 已轮换，直接重试原请求（浏览器自动带上新 rb_access）
        return api(originalRequest);
      } catch (refreshError) {
        // 刷新失败，清除本地会话数据并跳转到登录页
        if (typeof window !== 'undefined') {
          localStorage.removeItem('sessionId');
          localStorage.removeItem('hostInfo');
          // 尽力清除 httpOnly cookie（fire-and-forget）
          axios
            .post(`${api.defaults.baseURL}/auth/logout`, {}, { withCredentials: true })
            .catch(() => {});
          window.location.href = '/?reason=expired';
        }
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
