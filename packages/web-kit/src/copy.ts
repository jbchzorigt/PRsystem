/**
 * Mongolian copy shared by every portal.
 *
 * Each string is taken from the requirement documents where they name it;
 * what the documents leave unnamed — a sign-in button, an error line — uses
 * the plainest phrasing and is marked as such below. Portal-specific copy
 * lives with the portal.
 */
export const COMMON = {
  skipToContent: 'Үндсэн агуулга руу очих',
  signIn: 'Нэвтрэх',
  signOut: 'Гарах',
  email: 'Имэйл',
  password: 'Нууц үг',
  phone: 'Утасны дугаар',
  code: 'Код',
  submit: 'Илгээх',
  confirm: 'Баталгаажуулах',
  cancel: 'Цуцлах',
  back: 'Буцах',
  save: 'Хадгалах',
  search: 'Хайх',
  clear: 'Цэвэрлэх',
  details: 'Дэлгэрэнгүй',
  previous: 'Өмнөх',
  next: 'Дараах',
  page: 'Хуудас',
  nothingHere: 'Одоогоор бүртгэл байхгүй.',
  notAvailable: 'Энэ хэсэг таны эрх эсвэл багцад нээлттэй биш байна.',
  loadFailed: 'Мэдээлэл ачаалахад алдаа гарлаа.',
  reason: 'Шалтгаан',
  note: 'Тэмдэглэл',
  state: 'Төлөв',
  actions: 'Үйлдэл',
  total: 'Нийт',
  yes: 'Тийм',
  no: 'Үгүй',
  realm: 'Realm',
  signedInAs: 'Нэвтэрсэн',
  required: 'заавал',
} as const;

/** The API's error vocabulary, said to a person. */
export const ERROR_COPY: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: 'Оруулсан мэдээлэл буруу байна.',
  UNAUTHENTICATED: 'Нэвтрэх шаардлагатай.',
  FORBIDDEN: 'Энэ үйлдлийг хийх эрх байхгүй.',
  NOT_FOUND: 'Олдсонгүй эсвэл хандах эрх байхгүй.',
  CONFLICT: 'Мэдээлэл өөрчлөгдсөн байна; дахин ачаалж үзнэ үү.',
  IDEMPOTENCY_KEY_REUSED: 'Энэ хүсэлт өмнө нь өөр агуулгатай илгээгдсэн байна.',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'Ижил хүсэлт боловсруулагдаж байна.',
  PRECONDITION_FAILED: 'Урьдчилсан нөхцөл хангагдаагүй байна.',
  REVISION_MISMATCH: 'Мэдээлэл өөрчлөгдсөн байна; дахин ачаалж үзнэ үү.',
  RATE_LIMITED: 'Хэт олон оролдлого. Түр хүлээнэ үү.',
  TENANT_SCOPE_MISSING: 'Буудлын хүрээ тодорхойгүй байна.',
  EXTERNAL_GATE_CLOSED: 'Гадаад үйлчилгээ одоогоор нээлттэй биш байна.',
  DEPENDENCY_UNAVAILABLE: 'Үйлчилгээ түр боломжгүй байна.',
  INTERNAL_ERROR: 'Системийн алдаа гарлаа.',
  NETWORK: 'Сервертэй холбогдож чадсангүй.',
};

export function errorText(code: string, message?: string): string {
  const known = ERROR_COPY[code];
  if (known !== undefined)
    return message === undefined || message === '' ? known : `${known} (${message})`;
  return message ?? code;
}
