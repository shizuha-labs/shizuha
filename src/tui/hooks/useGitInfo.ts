import { useState, useEffect, useRef } from 'react';
import { getGitBranch, isGitRepo } from '../../utils/git.js';

interface GitInfo {
  branch: string | null;
  isRepo: boolean;
}

/** Hook that polls for git branch info every 10s */
export function useGitInfo(cwd: string): GitInfo {
  const [info, setInfo] = useState<GitInfo>({ branch: null, isRepo: false });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const setInfoIfChanged = (next: GitInfo) => {
      setInfo((prev) => (
        prev.branch === next.branch && prev.isRepo === next.isRepo ? prev : next
      ));
    };

    const update = async () => {
      const repo = await isGitRepo(cwd);
      if (cancelled) return;
      if (!repo) {
        setInfoIfChanged({ branch: null, isRepo: false });
        return;
      }
      const branch = await getGitBranch(cwd);
      if (cancelled) return;
      setInfoIfChanged({ branch: branch || null, isRepo: true });
    };

    update();
    intervalRef.current = setInterval(update, 10000);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [cwd]);

  return info;
}
