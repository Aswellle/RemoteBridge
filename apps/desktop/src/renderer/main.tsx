import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// ===== 错误边界 =====
// 渲染期未捕获异常若无边界兜底，整个窗口就是永久白屏且用户无法自救
// （Electron 窗口没有地址栏/刷新键）。这里给出错误信息和重新加载按钮。
interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('渲染端未捕获异常:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          height: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: 'hsl(222 47% 7%)', color: 'hsl(210 40% 96%)',
          fontFamily: 'system-ui, sans-serif', padding: 32, textAlign: 'center',
        }}>
          <h2 style={{ margin: 0 }}>界面渲染出错了</h2>
          <pre style={{
            maxWidth: 600, maxHeight: 200, overflow: 'auto', fontSize: 12,
            background: 'hsl(217 33% 12%)', padding: 12, borderRadius: 8,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px', borderRadius: 8, border: 'none',
              background: 'hsl(217 91% 60%)', color: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
