import { useEffect, useRef, useState } from "react";

/**
 * Reveals streamed text smoothly. Chunks arrive in bursts; instead of jumping, the visible length chases the
 * received length, faster the further behind it is. Text that was never live (history) shows immediately, and a
 * message that finishes streaming keeps catching up to its final text.
 */
export function Typewriter({ text, live }: { text: string; live: boolean }) {
  const animating = useRef(live);
  if (live) animating.current = true;
  const pos = useRef(animating.current ? 0 : text.length);
  const [shown, setShown] = useState(pos.current);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (!animating.current) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const backlog = target.current.length - pos.current;
      if (backlog > 0) {
        const speed = Math.max(40, backlog * 7); // chars/second: ~140 ms to catch up with any backlog
        pos.current = Math.min(target.current.length, pos.current + speed * dt);
        setShown(Math.floor(pos.current));
      }
      if (pos.current < target.current.length || live) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, live]);

  const visible = animating.current ? text.slice(0, shown) : text;
  return (
    <>
      {visible}
      {live && <span className="sc-caret" aria-hidden="true" />}
    </>
  );
}
