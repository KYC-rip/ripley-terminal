import { useEffect, useRef, useState } from 'react';
import { countVerdict, normalizePhrase, phraseWordCount, seedVerdict, shouldInspect, type SeedInspection, type SeedVerdict } from '../../seedVerdict';

const DEBOUNCE_MS = 350;

/**
 * Live verdict for the phrase box. `inspect_seed` runs PBKDF2 for a Polyseed (10k iterations ×
 * up to 10 languages), so: debounced ≥300 ms, at most ONE call in flight, and a result is only
 * shown if it is for the phrase currently in the box (stale results are dropped; the latest
 * phrase is re-inspected once the in-flight call settles).
 */
export function useSeedInspection(phrase: string): { verdict: SeedVerdict | null; inspection: SeedInspection | null; pending: boolean } {
  const normalized = normalizePhrase(phrase);
  const count = phraseWordCount(normalized);
  const canInspect = shouldInspect(count) && typeof window.api?.inspectSeed === 'function';

  const [result, setResult] = useState<{ phrase: string; inspection: SeedInspection } | null>(null);
  const latest = useRef(normalized);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  latest.current = normalized;

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!canInspect) return;
    const run = async () => {
      if (inFlight.current) return; // the settling call re-runs for the latest phrase
      const target = latest.current;
      if (!shouldInspect(phraseWordCount(target))) return;
      inFlight.current = true;
      let inspection: SeedInspection;
      try {
        inspection = await window.api.inspectSeed!(target);
      } catch (e: any) {
        inspection = { format: 'unknown', error: typeof e === 'string' ? e : (e?.message || 'Could not check this phrase') };
      } finally {
        inFlight.current = false;
      }
      if (!mounted.current) return;
      if (target === latest.current) setResult({ phrase: target, inspection });
      else void run();
    };
    const t = setTimeout(run, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [normalized, canInspect]);

  if (count === 0) return { verdict: null, inspection: null, pending: false };
  if (!shouldInspect(count)) return { verdict: countVerdict(count), inspection: null, pending: false };
  if (!canInspect) return { verdict: null, inspection: null, pending: false };
  if (result && result.phrase === normalized) return { verdict: seedVerdict(result.inspection), inspection: result.inspection, pending: false };
  return { verdict: null, inspection: null, pending: true };
}
