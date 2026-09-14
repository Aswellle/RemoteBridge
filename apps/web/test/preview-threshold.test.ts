import { describe, it, expect } from 'vitest';
import { PREVIEW_SIZE_THRESHOLD, PREVIEW_PARTIAL_BYTES } from '../src/hooks/usePreview';

describe('P1-08: Preview large file threshold', () => {
  it('defines 50MB threshold', () => {
    expect(PREVIEW_SIZE_THRESHOLD).toBe(50 * 1024 * 1024);
  });

  it('defines 1MB partial preview size', () => {
    expect(PREVIEW_PARTIAL_BYTES).toBe(1024 * 1024);
  });

  it('correctly identifies large files', () => {
    const smallFile = 1024 * 1024; // 1MB
    const largeFile = 100 * 1024 * 1024; // 100MB

    expect(smallFile > PREVIEW_SIZE_THRESHOLD).toBe(false);
    expect(largeFile > PREVIEW_SIZE_THRESHOLD).toBe(true);
  });
});
