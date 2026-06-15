import axios from 'axios';

// ===== 创建 Axios 实例 =====
const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ===== 刷新 Access Token =====
// 供响应拦截器和 WebSocket 重连（4001 时）共用。
// 刷新成功后必须同步 zustand store —— WS 重连优先读 store 里的 token，
// 只写 localStorage 会让 store 中的旧 token 继续被使用。
// （动态 import 避免 api.ts ↔ app-store.ts 的循环依赖）
let refreshPromise: Promise<string> | null = null;

export function refreshAccessToken(): Promise<string> {
  // 并发去重：多个 401/重连同时触发时只发一次刷新请求
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
      throw new Error('No refresh token');
    }

    const response = await axios.post(
      `${api.defaults.baseURL}/auth/refresh`,
      { refreshToken }
    );

    const { accessToken } = response.data.data;
    localStorage.setItem('accessToken', accessToken);

    try {
      const { useAppStore } = await import('@/store/app-store');
      useAppStore.setState({ accessToken });
    } catch {
      // store 尚未初始化（SSR 等场景）时忽略
    }

    return accessToken as string;
  })();

  refreshPromise.finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ===== 请求拦截器 =====
api.interceptors.request.use(
  (config) => {
    // 从 localStorage 获取 access token
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('accessToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// ===== 响应拦截器 =====
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // 如果是 401 错误且未重试过，尝试刷新 token
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const accessToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // 刷新失败，清除本地存储并跳转到登录页
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('sessionId');
        localStorage.removeItem('hostInfo');
        window.location.href = '/?reason=expired';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
