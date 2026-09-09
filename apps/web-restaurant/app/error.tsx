'use client';

/**
 * The portal's last resort. Nothing of the error itself is shown: a message
 * could carry a field value, and the person can retry from a clean page.
 */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main">
      <h1>{'Алдаа гарлаа'}</h1>
      <p>{'Хуудсыг ачаалахад алдаа гарлаа. Дахин оролдоно уу.'}</p>
      <button className="button" type="button" onClick={() => reset()}>
        {'Дахин оролдох'}
      </button>
    </main>
  );
}
