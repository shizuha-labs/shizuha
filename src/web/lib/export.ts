import type { ChatMessage } from './types';

export function exportAsMarkdown(messages: ChatMessage[]): string {
  const lines: string[] = [
    `# Shizuha Conversation`,
    `> Exported ${new Date().toLocaleString()}`,
    '',
  ];

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'You' : 'Shizuha';
    lines.push(`## ${role}`);
    lines.push('');

    if (msg.reasoningSummaries?.length) {
      lines.push('> **Reasoning:**');
      for (const s of msg.reasoningSummaries) {
        lines.push(`> - ${s}`);
      }
      lines.push('');
    }

    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        const status = tc.isError ? '✗' : '✓';
        const dur = tc.durationMs ? ` (${tc.durationMs}ms)` : '';
        lines.push(`> **Tool:** ${status} \`${tc.tool}\`${dur}`);
      }
      lines.push('');
    }

    lines.push(msg.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export function exportAsJSON(messages: ChatMessage[]): string {
  return JSON.stringify({
    exported: new Date().toISOString(),
    messages,
  }, null, 2);
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
