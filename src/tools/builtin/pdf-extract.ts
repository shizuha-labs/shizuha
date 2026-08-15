import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { resolveSafePath } from '../../utils/fs.js';
import { parsePageRange } from '../../utils/page-range.js';
import { logger } from '../../utils/logger.js';

/** Maximum output size to avoid blowing up the context window */
const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB

/** Extensions that are treated as plain-text fallback (not PDF) */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'json', 'xml', 'html', 'htm',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'rst', 'tex',
]);

const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10 MB (same as read tool)

export const pdfExtractTool: ToolHandler = {
  name: 'pdf_extract',
  description:
    'Extract text content from PDF files or read common document formats. ' +
    'For PDFs, extracts text with page markers. Supports page range selection. ' +
    'For non-PDF text files (.txt, .md, .csv, .json, .xml, .html, etc.), reads as plain text. ' +
    'Output is truncated to 50KB to avoid context overflow.',
  parameters: z.object({
    file_path: z.string().describe('Path to the PDF or document file'),
    pages: z.string().optional().describe('Page range (e.g. "1-5", "1,3,5", "all"). Default: all'),
    format: z.enum(['text', 'markdown']).optional().describe('Output format (default: text)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { file_path, pages, format } = this.parameters.parse(params);
    const resolved = resolveSafePath(file_path, context.cwd);
    const outputFormat = format ?? 'text';

    try {
      await fs.access(resolved);
    } catch {
      return { toolUseId: '', content: `File not found: ${resolved}`, isError: true };
    }

    const ext = path.extname(resolved).toLowerCase().slice(1);

    // For non-PDF text-based files, fall back to reading as text
    if (ext !== 'pdf' && TEXT_EXTENSIONS.has(ext)) {
      return readAsText(resolved, outputFormat);
    }

    if (ext !== 'pdf') {
      return {
        toolUseId: '',
        content: `Unsupported file type ".${ext}". Supported: .pdf, ${[...TEXT_EXTENSIONS].map(e => `.${e}`).join(', ')}`,
        isError: true,
      };
    }

    return extractPdf(resolved, pages, outputFormat);
  },
};

async function readAsText(filePath: string, format: string): Promise<ToolResult> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_TEXT_FILE_SIZE) {
      return {
        toolUseId: '',
        content: `File too large: ${stat.size} bytes (max ${MAX_TEXT_FILE_SIZE} bytes)`,
        isError: true,
      };
    }

    let content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const truncated = content.length > MAX_OUTPUT_BYTES;
    if (truncated) {
      content = content.slice(0, MAX_OUTPUT_BYTES);
    }

    const header = format === 'markdown'
      ? `# ${path.basename(filePath)}\n\n\`\`\`${ext}\n`
      : `File: ${path.basename(filePath)}\n${'='.repeat(40)}\n`;

    const footer = format === 'markdown'
      ? `\n\`\`\``
      : '';

    const truncNotice = truncated
      ? `\n\n[Output truncated at ${MAX_OUTPUT_BYTES} bytes]`
      : '';

    return {
      toolUseId: '',
      content: `${header}${content}${footer}${truncNotice}`,
    };
  } catch (err) {
    return { toolUseId: '', content: `Error reading file: ${(err as Error).message}`, isError: true };
  }
}

async function extractPdf(filePath: string, pagesSpec: string | undefined, format: string): Promise<ToolResult> {
  let pdfParse: typeof import('pdf-parse').default;
  try {
    // Dynamic import — type declarations in src/types/pdf-parse.d.ts
    const mod = await import('pdf-parse');
    pdfParse = mod.default ?? mod;
  } catch {
    return {
      toolUseId: '',
      content: 'pdf-parse package is not installed. Run: npm install pdf-parse',
      isError: true,
    };
  }

  try {
    const buffer = await fs.readFile(filePath);

    // pdf-parse can throw on encrypted/corrupt files
    const data = await pdfParse(buffer);

    const totalPages = data.numpages;
    const pageTexts: string[] = data.text.split(/\f/); // Form-feed typically separates pages

    // Determine which pages to include
    let pageIndices: number[];
    try {
      pageIndices = parsePageRange(pagesSpec ?? 'all', totalPages);
    } catch (rangeErr) {
      return { toolUseId: '', content: (rangeErr as Error).message, isError: true };
    }

    // Build output with page markers
    const sections: string[] = [];
    let totalSize = 0;
    let wasTruncated = false;

    for (const idx of pageIndices) {
      const pageNum = idx + 1;
      const pageText = (pageTexts[idx] ?? '').trim();

      let section: string;
      if (format === 'markdown') {
        section = `## Page ${pageNum}\n\n${pageText}`;
      } else {
        section = `--- Page ${pageNum} ---\n${pageText}`;
      }

      // Check if adding this section would exceed the limit
      const sectionBytes = Buffer.byteLength(section, 'utf-8');
      if (totalSize + sectionBytes > MAX_OUTPUT_BYTES) {
        // Trim the section to fit
        const remaining = MAX_OUTPUT_BYTES - totalSize;
        if (remaining > 100) {
          // Only include if we can fit a meaningful chunk
          sections.push(section.slice(0, remaining));
        }
        wasTruncated = true;
        break;
      }

      sections.push(section);
      totalSize += sectionBytes;
    }

    const header = format === 'markdown'
      ? `# ${path.basename(filePath)}\n\n**Pages:** ${totalPages} | **Extracted:** ${pageIndices.length} page(s)\n\n`
      : `File: ${path.basename(filePath)}\nPages: ${totalPages} | Extracted: ${pageIndices.length} page(s)\n${'='.repeat(40)}\n`;

    const truncNotice = wasTruncated
      ? `\n\n[Output truncated at ${MAX_OUTPUT_BYTES} bytes. Use the "pages" parameter to extract specific pages.]`
      : '';

    logger.debug({ file: filePath, totalPages, extracted: pageIndices.length }, 'PDF text extracted');

    return {
      toolUseId: '',
      content: `${header}${sections.join('\n\n')}${truncNotice}`,
      metadata: { totalPages, extractedPages: pageIndices.length, truncated: wasTruncated },
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);

    // Detect common PDF errors
    if (message.includes('encrypt') || message.includes('password')) {
      return { toolUseId: '', content: `Cannot extract text: PDF is encrypted or password-protected.`, isError: true };
    }
    if (message.includes('Invalid') || message.includes('corrupt') || message.includes('not a PDF')) {
      return { toolUseId: '', content: `Cannot extract text: file appears to be corrupt or not a valid PDF.`, isError: true };
    }

    logger.error({ err, file: filePath }, 'PDF extraction failed');
    return { toolUseId: '', content: `PDF extraction error: ${message}`, isError: true };
  }
}
