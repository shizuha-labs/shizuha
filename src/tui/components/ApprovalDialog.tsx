import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest } from '../state/types.js';
import { createUnifiedDiff } from '../../utils/diff.js';
import { DiffView } from './DiffView.js';

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onResolve: (decision: 'allow' | 'deny' | 'allow_always') => void;
  queueSize?: number;
}

export const ApprovalDialog: React.FC<ApprovalDialogProps> = ({ request, onResolve, queueSize }) => {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onResolve('allow');
    } else if (input === 'n' || input === 'N' || key.escape) {
      onResolve('deny');
    } else if (input === 'a' || input === 'A') {
      onResolve('allow_always');
    }
  });

  const riskColor = request.riskLevel === 'high' ? 'red' : request.riskLevel === 'medium' ? 'yellow' : 'green';
  const truncateInline = (value: string, max = 220): string => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, Math.max(1, max - 3))}...`;
  };
  const commandPreview = (() => {
    const explicit = request.input['command_preview'];
    if (typeof explicit === 'string' && explicit.trim()) return truncateInline(explicit, 260);
    if (request.toolName === 'bash') {
      const command = request.input['command'];
      if (typeof command === 'string' && command.trim()) {
        return `/bin/bash -lc '${truncateInline(command, 240).replace(/'/g, `'\\''`)}'`;
      }
    }
    return null;
  })();
  const parseEditInput = (input: Record<string, unknown>): {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
  } | null => {
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : null;
    const oldString = typeof input['old_string'] === 'string' ? input['old_string'] : null;
    const newString = typeof input['new_string'] === 'string' ? input['new_string'] : null;
    const replaceAll = Boolean(input['replace_all']);
    if (!filePath || oldString == null || newString == null) return null;
    return { filePath, oldString, newString, replaceAll };
  };
  const summarizeInput = (input: Record<string, unknown>): string[] => {
    const entries = Object.entries(input);
    if (entries.length === 0) return ['(no input)'];

    const lines: string[] = [];
    for (const [k, v] of entries.slice(0, 3)) {
      let valueStr: string;
      if (typeof v === 'string') {
        const singleLine = v.replace(/\s+/g, ' ').trim();
        valueStr = singleLine.length > 90 ? `${singleLine.slice(0, 90)}...` : singleLine;
      } else {
        const json = JSON.stringify(v);
        valueStr = (json && json.length > 90) ? `${json.slice(0, 90)}...` : (json ?? String(v));
      }
      lines.push(`${k}: ${valueStr}`);
    }
    if (entries.length > 3) lines.push(`+${entries.length - 3} more fields`);
    return lines;
  };
  const editInput = request.toolName === 'edit' ? parseEditInput(request.input) : null;
  const summaryLines = editInput ? [] : summarizeInput(request.input);
  const editPreviewDiff = editInput
    ? createUnifiedDiff(
      editInput.filePath,
      editInput.oldString,
      editInput.newString,
    )
    : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={0}>
      <Box>
        <Text bold color="yellow">{'\u26A0'} Permission Required</Text>
        {queueSize != null && queueSize > 1 && (
          <Text dimColor> ({queueSize - 1} more pending)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text>Tool: </Text>
        <Text bold>{request.toolName}</Text>
        <Text> </Text>
        <Text color={riskColor}>[{request.riskLevel}]</Text>
      </Box>
      {commandPreview && (
        <Box marginTop={0}>
          <Text dimColor>command: {commandPreview}</Text>
        </Box>
      )}
      {editInput && editPreviewDiff ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>file: {editInput.filePath}</Text>
          {editInput.replaceAll && <Text dimColor>replace_all: true</Text>}
          <Box marginTop={0} marginBottom={0}>
            <DiffView diff={editPreviewDiff} maxLines={18} />
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Box flexDirection="column">
            {summaryLines.map((line, idx) => (
              <Text key={`${idx}-${line}`} dimColor>{line}</Text>
            ))}
          </Box>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Text bold color="green">[Y]</Text><Text>es  </Text>
          <Text bold color="red">[N]</Text><Text>o  </Text>
          <Text bold color="cyan">[A]</Text><Text>lways allow this tool</Text>
        </Text>
      </Box>
    </Box>
  );
};
