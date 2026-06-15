import { useRef, useState, useEffect } from 'react';

// Returns 'up' | 'down' | null for one animation cycle whenever `value` changes.
export function useFlash(value) {
  const prev = useRef(value);
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (value == null || p == null || value === p) return;
    const dir = value > p ? 'up' : 'down';
    setFlash(dir);
    const t = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(t);
  }, [value]);
  return flash;
}
