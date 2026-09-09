import { Shell } from '@prsystem/web-kit';
import { OPS } from '../lib/copy';

export default function NotFound() {
  return (
    <Shell brand={OPS.brand} portal={OPS.portal}>
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
