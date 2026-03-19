/** Configurable status line items */
export type StatusItem =
  | 'model'
  | 'mode'
  | 'activity'
  | 'verbosity'
  | 'context'
  | 'cost'
  | 'tokens'
  | 'turns'
  | 'time'
  | 'lines'
  | 'session'
  | 'branch';

const ALL_ITEMS: StatusItem[] = ['model', 'mode', 'activity', 'verbosity', 'context', 'cost', 'tokens', 'turns', 'time', 'lines', 'session', 'branch'];

// Keep default statusline compact/human-friendly.
let _items: StatusItem[] = ['model', 'mode', 'activity', 'context', 'lines', 'branch'];

/** Get current visible status items */
export function getStatusItems(): StatusItem[] {
  return [..._items];
}

/** Set visible status items */
export function setStatusItems(items: StatusItem[]): void {
  _items = items.filter((i) => ALL_ITEMS.includes(i));
}

/** Toggle a status item on/off */
export function toggleStatusItem(item: StatusItem): boolean {
  const idx = _items.indexOf(item);
  if (idx >= 0) {
    _items.splice(idx, 1);
    return false;
  }
  _items.push(item);
  return true;
}

/** Get all available items */
export function getAllStatusItems(): StatusItem[] {
  return [...ALL_ITEMS];
}
