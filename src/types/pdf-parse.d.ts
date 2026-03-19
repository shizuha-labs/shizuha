declare module 'pdf-parse' {
  interface PdfData {
    /** Number of pages */
    numpages: number;
    /** Number of rendered pages */
    numrender: number;
    /** PDF info object */
    info: Record<string, unknown>;
    /** PDF metadata */
    metadata: unknown;
    /** PDF version */
    version: string;
    /** Extracted text content (pages separated by form-feed \f) */
    text: string;
  }

  interface PdfParseOptions {
    /** Max number of pages to parse (default: 0 = all) */
    max?: number;
    /** PDF.js version (default: bundled) */
    version?: string;
  }

  function pdfParse(dataBuffer: Buffer, options?: PdfParseOptions): Promise<PdfData>;

  export default pdfParse;
}
