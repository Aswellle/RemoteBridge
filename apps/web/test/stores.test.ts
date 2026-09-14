import { describe, it, expect, beforeEach } from 'vitest';
import { useTransferStore } from '../src/store/slices/transfer-store';
import { useSessionStore } from '../src/store/slices/session-store';
import { useFileStore } from '../src/store/slices/file-store';
import { usePreviewStore } from '../src/store/slices/preview-store';
import { useMessageStore } from '../src/store/slices/message-store';

describe('transfer-store', () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: [] });
  });

  it('adds a transfer', () => {
    const store = useTransferStore.getState();
    store.addTransfer({
      id: 't1',
      fileName: 'test.zip',
      filePath: '/path/test.zip',
      fileSize: 1000,
      progress: 0,
      direction: 'download',
      status: 'pending',
      startedAt: Date.now(),
    });

    expect(useTransferStore.getState().transfers).toHaveLength(1);
  });

  it('updates transfer progress', () => {
    const store = useTransferStore.getState();
    store.addTransfer({
      id: 't1',
      fileName: 'test.zip',
      filePath: '/path/test.zip',
      fileSize: 1000,
      progress: 0,
      direction: 'download',
      status: 'downloading',
      startedAt: Date.now(),
    });

    store.updateTransfer('t1', { progress: 50, status: 'completed' });
    const transfer = useTransferStore.getState().transfers[0];
    expect(transfer.progress).toBe(50);
    expect(transfer.status).toBe('completed');
  });

  it('filters active transfers', () => {
    const store = useTransferStore.getState();
    store.addTransfer({
      id: 't1', fileName: 'a.zip', filePath: '/a.zip', fileSize: 100,
      progress: 0, direction: 'download', status: 'pending', startedAt: Date.now(),
    });
    store.addTransfer({
      id: 't2', fileName: 'b.zip', filePath: '/b.zip', fileSize: 100,
      progress: 100, direction: 'download', status: 'completed', startedAt: Date.now(),
    });

    const active = store.getActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('t1');
  });

  it('clears completed transfers', () => {
    const store = useTransferStore.getState();
    store.addTransfer({
      id: 't1', fileName: 'a.zip', filePath: '/a.zip', fileSize: 100,
      progress: 100, direction: 'download', status: 'completed', startedAt: Date.now(),
    });
    store.addTransfer({
      id: 't2', fileName: 'b.zip', filePath: '/b.zip', fileSize: 100,
      progress: 50, direction: 'download', status: 'downloading', startedAt: Date.now(),
    });

    store.clearCompleted();
    const transfers = useTransferStore.getState().transfers;
    expect(transfers).toHaveLength(1);
    expect(transfers[0].id).toBe('t2');
  });
});

describe('session-store', () => {
  beforeEach(() => {
    useSessionStore.setState({
      connectionStatus: 'disconnected',
      hostInfo: null,
      sessionId: null,
      wsInstance: null,
    });
  });

  it('manages connection status', () => {
    const store = useSessionStore.getState();
    store.setConnectionStatus('connecting');
    expect(useSessionStore.getState().connectionStatus).toBe('connecting');

    store.setConnectionStatus('connected');
    expect(useSessionStore.getState().connectionStatus).toBe('connected');
  });

  it('manages session', () => {
    const store = useSessionStore.getState();
    store.setSession('sess-123');
    expect(useSessionStore.getState().sessionId).toBe('sess-123');

    store.clearSession();
    expect(useSessionStore.getState().sessionId).toBeNull();
  });
});

describe('file-store', () => {
  beforeEach(() => {
    useFileStore.setState({
      currentPath: null,
      dirEntries: [],
      allowedDirs: [],
      isLoadingDir: false,
    });
  });

  it('manages directory entries', () => {
    const store = useFileStore.getState();
    store.setCurrentPath('/home/user');
    store.setDirEntries([
      { name: 'file.txt', path: '/home/user/file.txt', type: 'file', size: 100, extension: 'txt', modifiedAt: 0, isPreviewable: false },

    ]);

    expect(useFileStore.getState().currentPath).toBe('/home/user');
    expect(useFileStore.getState().dirEntries).toHaveLength(1);
  });

  it('manages loading state', () => {
    const store = useFileStore.getState();
    store.setIsLoadingDir(true);
    expect(useFileStore.getState().isLoadingDir).toBe(true);
  });
});

describe('preview-store', () => {
  beforeEach(() => {
    usePreviewStore.getState().clearPreview();
  });

  it('sets preview data', () => {
    const store = usePreviewStore.getState();
    store.setPreview({
      previewUrl: 'blob:http://localhost/abc',
      fileName: 'image.png',
      category: 'image',
      loading: false,
    });

    const state = usePreviewStore.getState();
    expect(state.previewUrl).toBe('blob:http://localhost/abc');
    expect(state.fileName).toBe('image.png');
  });

  it('clears preview', () => {
    usePreviewStore.getState().setPreview({ fileName: 'test.png' });
    usePreviewStore.getState().clearPreview();
    expect(usePreviewStore.getState().fileName).toBe('');
  });

  it('tracks partial preview flag', () => {
    usePreviewStore.getState().setPreview({ isPartial: true });
    expect(usePreviewStore.getState().isPartial).toBe(true);
  });
});

describe('message-store', () => {
  beforeEach(() => {
    useMessageStore.setState({ messages: [], unreadCount: 0 });
  });

  it('adds messages', () => {
    const store = useMessageStore.getState();
    store.addMessage({
      id: 'm1',
      content: 'Hello',
      direction: 'client_to_host',
      type: 'text',
      timestamp: Date.now(),
    });

    expect(useMessageStore.getState().messages).toHaveLength(1);
    expect(useMessageStore.getState().unreadCount).toBe(1);
  });

  it('marks messages read', () => {
    useMessageStore.getState().addMessage({
      id: 'm1', content: 'Hi', direction: 'host_to_client', type: 'text', timestamp: Date.now(),
    });
    useMessageStore.getState().markMessagesRead();
    expect(useMessageStore.getState().unreadCount).toBe(0);
  });

  it('updates message', () => {
    useMessageStore.getState().addMessage({
      id: 'm1', content: 'Hi', direction: 'host_to_client', type: 'text', timestamp: Date.now(),
    });
    useMessageStore.getState().updateMessage('m1', { content: 'Updated' });
    expect(useMessageStore.getState().messages[0].content).toBe('Updated');
  });
});
