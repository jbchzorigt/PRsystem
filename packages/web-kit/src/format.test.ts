import { describe, expect, it } from 'vitest';
import { addDays, formatDateTime, formatMinutes, formatMnt, formatTime } from './format';
import { errorText } from './copy';

describe('portal formatting', () => {
  it('formats whole MNT and leaves anything else alone', () => {
    expect(formatMnt('240000')).toBe('240,000₮');
    expect(formatMnt(0)).toBe('0₮');
    expect(formatMnt('-1500')).toBe('−1,500₮');
    expect(formatMnt(null)).toBe('—');
    expect(formatMnt('12.5')).toBe('12.5');
  });

  it('renders hotel-local time', () => {
    expect(formatDateTime('2026-09-09T06:30:00Z')).toBe('2026-09-09 14:30');
    expect(formatTime('2026-09-09T06:30:00Z')).toBe('14:30');
    expect(formatDateTime('nope')).toBe('—');
  });

  it('says minutes the way a remaining time reads', () => {
    expect(formatMinutes(42)).toBe('42 мин');
    expect(formatMinutes(120)).toBe('2 ц');
    expect(formatMinutes(135)).toBe('2 ц 15 мин');
    expect(formatMinutes(-3)).toBe('0 мин');
  });

  it('adds calendar days without a timezone slip', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 2)).toBe('2027-01-02');
  });

  it('turns an API code into a sentence, keeping the message when there is one', () => {
    expect(errorText('NOT_FOUND')).toBe('Олдсонгүй эсвэл хандах эрх байхгүй.');
    expect(errorText('CONFLICT', 'ROOM_OCCUPIED')).toContain('ROOM_OCCUPIED');
    expect(errorText('SOMETHING_NEW', 'x')).toBe('x');
  });
});
