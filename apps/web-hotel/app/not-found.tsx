import { Shell } from '@prsystem/web-kit';
import { HOTEL } from '../lib/copy';

export default function NotFound() {
  return (
    <Shell brand={HOTEL.brand} portal={HOTEL.portal}>
      <h1>{'Олдсонгүй'}</h1>
      <p>{'Хуудас байхгүй эсвэл хандах эрх байхгүй байна.'}</p>
      <p>
        <a className="button button-secondary" href="/">
          {'Нүүр хуудас'}
        </a>
      </p>
    </Shell>
  );
}
