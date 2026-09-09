import { Badge, Banner, COMMON, Field, errorText, formatMnt } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { RESTAURANT } from '../../lib/copy';
import { api, headersFor, requireGuestSession } from '../../lib/portal';
import { RestaurantShell } from '../../lib/shell';
import { placeOrder } from '../actions';

interface MenuItem {
  readonly itemId: string;
  readonly name: string;
  readonly priceMnt: string;
  readonly available: boolean;
  readonly category?: string;
}
interface Restaurant {
  readonly restaurantId: string;
  readonly displayName: string;
  readonly open: boolean;
  readonly items: readonly MenuItem[];
}

/** doc 08 §5–§6: the linked restaurants, what they serve, and one basket per restaurant. */
export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outcome = outcomeOf(await searchParams);
  const token = await requireGuestSession();
  const answer = await api().call<{ restaurants: readonly Restaurant[] }>(
    '/restaurant/guest/menus',
    { headers: headersFor(token) },
  );
  return (
    <RestaurantShell current="menu">
      <h1>{RESTAURANT.menu.title}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {!answer.ok ? (
        <p role="alert">{errorText(answer.code, answer.message)}</p>
      ) : answer.body.restaurants.length === 0 ? (
        <p>{COMMON.nothingHere}</p>
      ) : (
        answer.body.restaurants.map((restaurant) => (
          <section key={restaurant.restaurantId} aria-labelledby={`r-${restaurant.restaurantId}`}>
            <h2 id={`r-${restaurant.restaurantId}`}>
              {restaurant.displayName}{' '}
              <Badge tone={restaurant.open ? 'ok' : 'warn'}>
                {restaurant.open ? RESTAURANT.menu.open : RESTAURANT.menu.closed}
              </Badge>
            </h2>
            <form
              action={placeOrder}
              aria-label={`${RESTAURANT.menu.order}: ${restaurant.displayName}`}
            >
              <input type="hidden" name="restaurantId" value={restaurant.restaurantId} />
              <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
              <ul className="card-list">
                {restaurant.items.map((item) => (
                  <li className="card" key={item.itemId}>
                    <h3>{item.name}</h3>
                    <p>{formatMnt(item.priceMnt)}</p>
                    {item.available ? (
                      <Field id={`qty-${item.itemId}`} label={RESTAURANT.menu.quantity}>
                        <input
                          id={`qty-${item.itemId}`}
                          name={`qty:${item.itemId}`}
                          type="number"
                          min={0}
                          max={50}
                          step={1}
                          defaultValue={0}
                          inputMode="numeric"
                        />
                      </Field>
                    ) : (
                      <Badge tone="warn">{RESTAURANT.menu.soldOut}</Badge>
                    )}
                  </li>
                ))}
              </ul>
              <Field id={`note-${restaurant.restaurantId}`} label={RESTAURANT.menu.note}>
                <input id={`note-${restaurant.restaurantId}`} name="note" maxLength={300} />
              </Field>
              <button className="button" type="submit" disabled={!restaurant.open}>
                {RESTAURANT.menu.order}
              </button>
            </form>
          </section>
        ))
      )}
    </RestaurantShell>
  );
}
