import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { pasteBufferRef } from './InputBox.js';
import { findLineEnd, findLineStart, findNextWordEnd, findPreviousWordStart } from '../utils/textEdit.js';

interface MultiLineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
  textColor?: string;
  backgroundColor?: string;
  placeholderColor?: string;
  cursorForegroundColor?: string;
  cursorBackgroundColor?: string;
  width?: number;
  promptChar?: string;
  promptColor?: string;
  rightGutter?: number;
}

/**
 * Custom multi-line text input component for Ink.
 * - Ctrl+J inserts a newline
 * - Ctrl+Backspace / Ctrl+W deletes previous word
 * - Ctrl+Delete deletes next word
 * - Ctrl+Left/Ctrl+Right (or Alt+B/Alt+F) moves by word
 * - Ctrl+A/Ctrl+E moves to line start/end
 * - Enter submits
 * - Arrow keys navigate within text
 * - Backspace deletes at cursor
 */
export const MultiLineInput: React.FC<MultiLineInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder,
  isActive = true,
  textColor,
  backgroundColor,
  placeholderColor = 'gray',
  cursorForegroundColor = 'black',
  cursorBackgroundColor = 'white',
  width,
  promptChar = '\u276F',
  promptColor = textColor,
  rightGutter = 1,
}) => {
  const [, setCursor] = useState(0);
  const [, setRenderTick] = useState(0);
  const cursorRef = useRef(0);
  const valueRef = useRef(value);
  const targetWidth = Math.max(4, width ?? 0);
  const prefixWidth = 2; // prompt + space
  const contentWidth = Math.max(1, targetWidth - prefixWidth - Math.max(0, rightGutter));

  const fillToWidth = (text: string, maxWidth: number): string => {
    const clipped = text.length > maxWidth ? text.slice(0, maxWidth) : text;
    return clipped + ' '.repeat(Math.max(0, maxWidth - clipped.length));
  };

  interface VisualLine {
    text: string;
    logicalLineIndex: number;
    segmentStart: number;
  }

  const wrapLine = (line: string): string[] => {
    if (line.length === 0) return [''];
    const wrapped: string[] = [];
    for (let i = 0; i < line.length; i += contentWidth) {
      wrapped.push(line.slice(i, i + contentWidth));
    }
    return wrapped;
  };

  const sanitizePastedChunk = (text: string): string => {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  };

  const sanitizeInlineChunk = (text: string): string => {
    return text
      .replace(/[\r\n]/g, '')
      .replace(/\t/g, '    ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  };

  // FIFO of local commits acknowledged back through parent `value` props.
  // This prevents transient prop rollbacks from rewinding the live refs.
  const pendingCommitAcksRef = useRef<string[]>([]);

  const commitValue = useCallback((nextValue: string, nextCursor: number) => {
    valueRef.current = nextValue;
    cursorRef.current = Math.max(0, Math.min(nextCursor, nextValue.length));
    pendingCommitAcksRef.current.push(nextValue);
    if (pendingCommitAcksRef.current.length > 128) {
      pendingCommitAcksRef.current.splice(0, pendingCommitAcksRef.current.length - 128);
    }
    onChange(nextValue);
    setCursor(cursorRef.current);
  }, [onChange]);

  const inputHandlerRef = useRef<(input: string, key: any) => void>(() => {});
  inputHandlerRef.current = (input: string, key: any) => {
    if (!isActive) return;
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;

    // Bracketed paste detection: pasted text arrives as a single input with
    // embedded newlines (or CRLF). Normalize before inserting so rendering
    // stays stable and background fill remains uniform.
    if (input.length > 1 && (input.includes('\n') || input.includes('\r'))) {
      const normalized = sanitizePastedChunk(input);
      if (!normalized) return;
      // Large paste: store in shared ref for deferred expansion on submit
      if (normalized.length > 1024) {
        const lines = normalized.split('\n').length;
        pasteBufferRef.current = normalized;
        const placeholder = `[Pasted ${normalized.length} chars, ${lines} lines]`;
        const newValue = currentValue.slice(0, currentCursor) + placeholder + currentValue.slice(currentCursor);
        commitValue(newValue, currentCursor + placeholder.length);
      } else {
        // Normal paste: insert as multi-line, don't submit
        const newValue = currentValue.slice(0, currentCursor) + normalized + currentValue.slice(currentCursor);
        commitValue(newValue, currentCursor + normalized.length);
      }
      return;
    }

    // Ctrl+J = insert newline
    if (key.ctrl && input === 'j') {
      const newValue = currentValue.slice(0, currentCursor) + '\n' + currentValue.slice(currentCursor);
      commitValue(newValue, currentCursor + 1);
      return;
    }

    // Submit path should work even when terminal emits Enter as '\r',
    // Ctrl+M, or text plus return in a single input event.
    const isSubmit = key.return || input === '\r' || input === '\n' || (key.ctrl && input.toLowerCase() === 'm');
    if (isSubmit) {
      const pendingText = input.replace(/[\r\n]/g, '');
      const nextValue = currentValue.slice(0, currentCursor) + pendingText + currentValue.slice(currentCursor);
      onSubmit(nextValue);
      valueRef.current = '';
      cursorRef.current = 0;
      setCursor(0);
      return;
    }

    // Ctrl+Backspace / Ctrl+W: delete previous word run
    const isCtrlWordDelete =
      (key.ctrl && (key.backspace || key.delete)) ||
      input === '\u0017' ||
      (key.ctrl && input.toLowerCase() === 'w');
    if (isCtrlWordDelete) {
      if (currentCursor > 0) {
        const start = findPreviousWordStart(currentValue, currentCursor);
        const newValue = currentValue.slice(0, start) + currentValue.slice(currentCursor);
        commitValue(newValue, start);
      }
      return;
    }

    // Some terminals emit held backspace as a run of DEL/BS chars.
    if (!key.ctrl && !key.meta && /^[\u0008\u007f]+$/.test(input)) {
      if (currentCursor <= 0) return;
      const removeCount = Math.min(currentCursor, input.length);
      const start = currentCursor - removeCount;
      const newValue = currentValue.slice(0, start) + currentValue.slice(currentCursor);
      commitValue(newValue, start);
      return;
    }

    // Ctrl+Delete: delete next word run
    const isCtrlDeleteForward = (key.ctrl && key.delete && !key.backspace) || input === '\u001b[3;5~';
    if (isCtrlDeleteForward) {
      const end = findNextWordEnd(currentValue, currentCursor);
      if (end > currentCursor) {
        const newValue = currentValue.slice(0, currentCursor) + currentValue.slice(end);
        commitValue(newValue, currentCursor);
      }
      return;
    }

    // Ctrl+Left / Alt+B: move to previous word boundary
    const isWordLeft =
      (key.ctrl && key.leftArrow) ||
      input === '\u001b[1;5D' ||
      input === '\u001b[5D' ||
      (key.meta && input.toLowerCase() === 'b') ||
      input === '\u001bb';
    if (isWordLeft) {
      const nextCursor = findPreviousWordStart(currentValue, currentCursor);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }

    // Ctrl+Right / Alt+F: move to next word boundary
    const isWordRight =
      (key.ctrl && key.rightArrow) ||
      input === '\u001b[1;5C' ||
      input === '\u001b[5C' ||
      (key.meta && input.toLowerCase() === 'f') ||
      input === '\u001bf';
    if (isWordRight) {
      const nextCursor = findNextWordEnd(currentValue, currentCursor);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }

    // Home / Ctrl+A: start of line
    const isLineStart =
      ((key as { home?: boolean }).home ?? false) ||
      (key.ctrl && input.toLowerCase() === 'a') ||
      input === '\u0001' ||
      input === '\u001b[H' ||
      input === '\u001bOH';
    if (isLineStart) {
      const nextCursor = findLineStart(currentValue, currentCursor);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }

    // End / Ctrl+E: end of line
    const isLineEnd =
      ((key as { end?: boolean }).end ?? false) ||
      (key.ctrl && input.toLowerCase() === 'e') ||
      input === '\u0005' ||
      input === '\u001b[F' ||
      input === '\u001bOF';
    if (isLineEnd) {
      const nextCursor = findLineEnd(currentValue, currentCursor);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (currentCursor > 0) {
        const newValue = currentValue.slice(0, currentCursor - 1) + currentValue.slice(currentCursor);
        commitValue(newValue, currentCursor - 1);
      }
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      const nextCursor = Math.max(0, currentCursor - 1);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      const nextCursor = Math.min(currentValue.length, currentCursor + 1);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }

    // Up/Down handled by parent (history) — only forward if on first/last line
    if (key.upArrow || key.downArrow) return;

    // Escape, Ctrl+U, Ctrl+K handled by parent
    if (key.escape) return;
    if (key.ctrl) return;
    if (key.meta) return;

    // Tab — ignore (handled by parent for completion)
    if (key.tab) return;

    // Regular character input
    if (input) {
      const sanitized = sanitizeInlineChunk(input);
      if (!sanitized) return;
      const newValue = currentValue.slice(0, currentCursor) + sanitized + currentValue.slice(currentCursor);
      commitValue(newValue, currentCursor + sanitized.length);
    }
  };
  const stableInputHandler = useCallback((input: string, key: any) => {
    inputHandlerRef.current(input, key);
  }, []);
  useInput(stableInputHandler, { isActive });

  // Ack parent echoes of our local commits without mutating refs. For truly
  // external value updates (history restore, parent clear), sync refs.
  React.useEffect(() => {
    const pending = pendingCommitAcksRef.current;
    const ackIdx = pending.indexOf(value);
    if (ackIdx >= 0) {
      pending.splice(0, ackIdx + 1);
      return;
    }

    if (valueRef.current !== value) {
      valueRef.current = value;
      // Clamp cursor if external value is shorter than current cursor
      if (cursorRef.current > value.length) {
        cursorRef.current = value.length;
        setCursor(value.length);
      } else {
        // Force visual refresh for external value changes with same cursor.
        setRenderTick((n) => n + 1);
      }
    }
    if (value === '') {
      cursorRef.current = 0;
      setCursor(0);
    }
  }, [value]);

  // Render from refs — they are always in sync with each other because
  // commitValue updates both atomically. The `value` prop and `cursor` state
  // update at different speeds (prop round-trips through parent, state is local)
  // so using them together causes cursor jumps during fast typing.
  const renderValue = valueRef.current;
  const renderCursor = cursorRef.current;

  if (!renderValue && placeholder) {
    const prefix = `${promptChar} `;
    const trailing = ' '.repeat(Math.max(0, rightGutter));
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={promptColor} backgroundColor={backgroundColor}>{prefix}</Text>
          <Text color={placeholderColor} backgroundColor={backgroundColor}>{fillToWidth(placeholder, contentWidth)}{trailing}</Text>
        </Box>
      </Box>
    );
  }

  const lines = renderValue.split('\n');

  // Find cursor line and column
  let charsSoFar = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]!.length;
    if (charsSoFar + lineLen >= renderCursor && renderCursor <= charsSoFar + lineLen) {
      cursorLine = i;
      cursorCol = renderCursor - charsSoFar;
      break;
    }
    charsSoFar += lineLen + 1; // +1 for \n
  }

  const visualLines: VisualLine[] = [];
  lines.forEach((line, logicalLineIndex) => {
    const wrapped = wrapLine(line);
    wrapped.forEach((segment, segIndex) => {
      visualLines.push({
        text: segment,
        logicalLineIndex,
        segmentStart: segIndex * contentWidth,
      });
    });
    // Cursor at end-of-line exactly on wrap boundary should be visible on a
    // new wrapped row directly after that line's last segment.
    if (
      logicalLineIndex === cursorLine &&
      line.length > 0 &&
      cursorCol === line.length &&
      line.length % contentWidth === 0
    ) {
      visualLines.push({
        text: '',
        logicalLineIndex,
        segmentStart: line.length,
      });
    }
  });

  const cursorVisualIndex = visualLines.findIndex((line) => {
    if (line.logicalLineIndex !== cursorLine) return false;
    const end = line.segmentStart + line.text.length;
    if (line.text.length === 0) return cursorCol === line.segmentStart;
    return cursorCol >= line.segmentStart && cursorCol <= end;
  });

  return (
    <Box flexDirection="column" width={targetWidth}>
      {visualLines.map((line, i) => {
        const isCurrentLine = i === cursorVisualIndex;
        const prefix = i === 0 ? `${promptChar} ` : '  ';
        const trailing = ' '.repeat(Math.max(0, rightGutter));
        return (
          <Box key={`${line.logicalLineIndex}-${line.segmentStart}-${i}`} width={targetWidth}>
            <Text color={i === 0 ? promptColor : textColor} backgroundColor={backgroundColor}>{prefix}</Text>
            {isActive && isCurrentLine ? (
              (() => {
                const cursorInLine = Math.max(0, Math.min(contentWidth, cursorCol - line.segmentStart));
                const before = line.text.slice(0, cursorInLine);
                const cursorChar = line.text[cursorInLine] ?? ' ';
                const after = line.text.slice(cursorInLine + 1);
                const padding = Math.max(0, contentWidth - (before.length + 1 + after.length));
                return (
                  <Text color={textColor} backgroundColor={backgroundColor}>
                    {before}
                    <Text color={cursorForegroundColor} backgroundColor={cursorBackgroundColor}>{cursorChar}</Text>
                    {after}
                    {' '.repeat(padding)}
                    {trailing}
                  </Text>
                );
              })()
            ) : (
              <Text color={textColor} backgroundColor={backgroundColor}>{fillToWidth(line.text, contentWidth)}{trailing}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
