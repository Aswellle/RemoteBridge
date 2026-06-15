import { describe, it, expect } from 'vitest';
import {
  getFileCategory,
  isPreviewableFile,
  formatFileSize,
  getFileExtension,
  getFileName,
  getParentPath,
  PREVIEWABLE_TYPES,
} from '../src/file-utils';

describe('getFileCategory', () => {
  it('classifies images', () => {
    expect(getFileCategory('png')).toBe('image');
    expect(getFileCategory('JPG')).toBe('image');
    expect(getFileCategory('ico')).toBe('image');
  });

  it('classifies text/code files', () => {
    expect(getFileCategory('ts')).toBe('text');
    expect(getFileCategory('rb')).toBe('text');
    expect(getFileCategory('gitignore')).toBe('text');
  });

  it('classifies pdf', () => {
    expect(getFileCategory('pdf')).toBe('pdf');
  });

  it('returns unknown for unrecognized extensions', () => {
    expect(getFileCategory('exe')).toBe('unknown');
    expect(getFileCategory('')).toBe('unknown');
  });
});

describe('isPreviewableFile', () => {
  it('matches every category in PREVIEWABLE_TYPES', () => {
    for (const exts of Object.values(PREVIEWABLE_TYPES)) {
      for (const ext of exts) {
        expect(isPreviewableFile(ext)).toBe(true);
      }
    }
  });

  it('returns false for unknown extensions', () => {
    expect(isPreviewableFile('exe')).toBe(false);
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
  });
});

describe('getFileExtension', () => {
  it('extracts lowercase extension', () => {
    expect(getFileExtension('Report.PDF')).toBe('pdf');
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
  });

  it('returns empty string when there is no extension', () => {
    expect(getFileExtension('README')).toBe('');
  });

  it('treats dotfiles as having an extension', () => {
    expect(getFileExtension('.gitignore')).toBe('gitignore');
  });
});

describe('getFileName / getParentPath', () => {
  it('extracts the file name from a path', () => {
    expect(getFileName('/home/user/docs/report.pdf')).toBe('report.pdf');
    expect(getFileName('C:\\Users\\test\\report.pdf')).toBe('report.pdf');
  });

  it('extracts the parent path', () => {
    expect(getParentPath('/home/user/docs/report.pdf')).toBe('/home/user/docs');
    expect(getParentPath('report.pdf')).toBeNull();
  });
});
