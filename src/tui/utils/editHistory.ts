export interface EditRecord {
  filePath: string;
  oldContent: string;
  newContent: string;
  timestamp: number;
}

const editStack: EditRecord[] = [];

/** Track file changes added/removed for status bar */
let _linesAdded = 0;
let _linesRemoved = 0;

/** Push an edit onto the undo stack */
export function pushEdit(record: EditRecord): void {
  editStack.push(record);
  // Track line changes
  const oldLines = record.oldContent.split('\n').length;
  const newLines = record.newContent.split('\n').length;
  const delta = newLines - oldLines;
  if (delta > 0) _linesAdded += delta;
  if (delta < 0) _linesRemoved += Math.abs(delta);
}

/** Pop the most recent edit for undo */
export function popEdit(): EditRecord | undefined {
  return editStack.pop();
}

/** Clear the edit history */
export function clearEditHistory(): void {
  editStack.length = 0;
  _linesAdded = 0;
  _linesRemoved = 0;
}

/** Get current edit stack size */
export function editHistorySize(): number {
  return editStack.length;
}

/** Get line change stats */
export function getLineStats(): { added: number; removed: number } {
  return { added: _linesAdded, removed: _linesRemoved };
}
