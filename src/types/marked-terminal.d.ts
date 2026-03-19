declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  interface TerminalRendererOptions {
    width?: number;
    tab?: number;
    code?: boolean;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
  }

  export function markedTerminal(options?: TerminalRendererOptions): MarkedExtension;
}
