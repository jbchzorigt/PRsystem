import { Shell } from '@prsystem/web-kit';
import { POLICE } from '../lib/copy';

export default function NotFound() {
  return (
    <Shell brand={POLICE.brand} portal={POLICE.portal}>
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
