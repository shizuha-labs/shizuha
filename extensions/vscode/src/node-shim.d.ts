declare const process: {
  env: Record<string, string | undefined>;
};

declare module 'node:child_process' {
  export interface ChildProcess {
    killed: boolean;
    unref(): void;
  }
  export interface SpawnOptions {
    detached?: boolean;
    stdio?: 'ignore' | 'pipe' | 'inherit' | readonly unknown[];
    env?: Record<string, string | undefined>;
  }
  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
}
