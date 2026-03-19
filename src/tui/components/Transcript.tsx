import React from 'react';
import { Box } from 'ink';
import type { TranscriptEntry } from '../state/types.js';
import { MessageBlock } from './MessageBlock.js';
import type { VerbosityLevel } from '../hooks/useSlashCommands.js';

interface TranscriptProps {
  entries: TranscriptEntry[];
  verbosity?: VerbosityLevel;
}

export const Transcript: React.FC<TranscriptProps> = React.memo(({
  entries,
  verbosity = 'normal',
}) => {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {entries.map((entry) => (
        <MessageBlock key={entry.id} entry={entry} verbosity={verbosity} />
      ))}
    </Box>
  );
});
Transcript.displayName = 'Transcript';
