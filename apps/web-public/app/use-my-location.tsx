'use client';

import { useId, useState } from 'react';

/**
 * doc 09 §4: the position is asked for with an explanation, only on the
 * person's own action, and travels as two hidden fields of the search — never
 * to a profile, and the server computes every distance itself.
 */
export function UseMyLocation({
  label,
  why,
  denied,
}: {
  readonly label: string;
  readonly why: string;
  readonly denied: string;
}) {
  const [point, setPoint] = useState<{ lat: number; lng: number } | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const id = useId();
  const ask = (): void => {
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setMessage(denied);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setPoint({ lat: position.coords.latitude, lng: position.coords.longitude });
        setMessage(undefined);
      },
      () => setMessage(denied),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  };
  return (
    <div className="field span-2">
      <p className="hint" id={`${id}-why`}>
        {why}
      </p>
      <button
        className="button button-secondary"
        type="button"
        onClick={ask}
        aria-describedby={`${id}-why`}
      >
        {label}
      </button>
      {point !== undefined ? (
        <>
          <input type="hidden" name="latitudeMicro" value={Math.round(point.lat * 1_000_000)} />
          <input type="hidden" name="longitudeMicro" value={Math.round(point.lng * 1_000_000)} />
          <p className="hint" role="status">
            {'Байршил сонгогдлоо.'}
          </p>
        </>
      ) : null}
      {message !== undefined ? (
        <p className="hint" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
