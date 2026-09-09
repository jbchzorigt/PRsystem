import { Field, addDays, todayHotelLocal } from '@prsystem/web-kit';
import { GUEST } from '../lib/copy';
import { GuestShell } from '../lib/shell';
import { UseMyLocation } from './use-my-location';

/** doc 09 §3.1: the home page is the search. Nobody has to sign in to search. */
export default async function HomePage() {
  const today = todayHotelLocal();
  return (
    <GuestShell current="home">
      <h1>{GUEST.search.title}</h1>
      <form method="get" action="/hotels" className="form-grid" aria-labelledby="search-title">
        <h2 id="search-title" className="visually-hidden">
          {GUEST.search.title}
        </h2>
        <Field id="checkIn" label={GUEST.search.checkIn}>
          <input id="checkIn" name="checkIn" type="date" defaultValue={today} required />
        </Field>
        <Field id="checkOut" label={GUEST.search.checkOut}>
          <input
            id="checkOut"
            name="checkOut"
            type="date"
            defaultValue={addDays(today, 1)}
            required
          />
        </Field>
        <Field id="location" label={GUEST.search.location}>
          <input id="location" name="location" autoComplete="off" />
        </Field>
        <UseMyLocation
          label={GUEST.search.useMyLocation}
          why={GUEST.search.locationWhy}
          denied={GUEST.search.locationDenied}
        />
        <div className="actions span-2">
          <button className="button" type="submit">
            {GUEST.search.submit}
          </button>
        </div>
      </form>
    </GuestShell>
  );
}
