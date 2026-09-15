# Хэсэгчилсэн хөдөлгөөн ба буцаалт — implementation candidate

Хэсэгчилсэн хөдөлгөөн анхны хүсэлт, тооллогын source болон оноосон Cleaner
ажилтай холбогдоно. Тоо, чиглэл, өрөө/агуулахын үлдэгдэл, өртөг серверээс
тооцогдоно. Батлагдсан Manager count resolution нь бодит хөдөлгөөнтэй хамт
атомикаар бүртгэгдэнэ. Эцсийн apply зөвхөн үлдсэн зөрүүг шилжүүлнэ.

Хөдөлгөөнгүй хүсэлт шууд CANCELLED болно. Хөдөлгөөнтэй бол Manager-ийн
шалтгаантай cancellation ROLLBACK_REQUIRED үүсгэж, original baseline болон
анхны movement ID-уудыг серверээс snapshot болгоно. Тухайн Cleaner task
үргэлжилнэ; Manager-ийн өмнөх continuation/reassignment механизм үйлчилнэ.
Анхны хөдөлгөөн болон хорогдол/тооллогын бодит залруулгыг устгахгүй.

Буцаалт нь original baseline − current physical quantity гэсэн хязгаартай.
Хорогдсон барааг зохиомлоор сэргээхгүй: Manager шалтгаантай adjustment хийж,
ашиглах боломжтой нөөцөөр нөхөх шаардлагатай. Бодит тоо зөрвөл шилжүүлэлтийг
хориглоно. Бүх барааны final count анхны baseline-тай таарч, өрөөний өмнөх
configuration хэвээр үед ROLLED_BACK болно. Цэвэрлэгээний төлөв өөрчлөгдөхгүй.

Мigration 074 нь immutable movement/step/rollback history, forced tenant RLS,
current assignment/revision, bounded transfer, deferred physical proof болон
room blocker хамгаалалттай. APPLIED хүсэлтийг цуцлахгүй; шинэ request ашиглана.

## Баталгаажуулалт

- Chromium partial/rollback suite: 3 үйлдэл, lost-response retry-тай 5 API model хүсэлт.
- Өмнөх reconciliation Chromium suite амжилттай.
- 10 partial rollback + 1 batch cancellation PostgreSQL acceptance test нэмсэн; локал PostgreSQL байхгүй тул
  эдгээр нь одоогоор **гүйцэтгээгүй**, skip нь pass нотолгоо биш.
- SQL parser ба Python/JavaScript syntax шалгалт амжилттай. Энэ нь RLS,
  deferred trigger, locking болон migration execution-ийг батлахгүй.

Энэ candidate болон өргөтгөсөн Restaurant багцыг public GitHub-д нийтлэх
автомат approval review хориглосон. Remote CI хүлээгдэж буй; production
эсвэл бүрэн accepted гэж тэмдэглээгүй.

Batch-ийн үлдсэн ажлыг цуцлахад хэсэгчилсэн хүүхэд хүсэлт ROLLBACK_REQUIRED,
хөдөлгөөнгүй нь CANCELLED болно. Давтан цуцлалт нээлттэй буцаалтын ажлыг
алга болгохгүй. Partial movement-ийн дараа анхны хуучирсан тооллогод шинэ
variance decision нэмж болохгүй; буцаалт болон шалтгаантай stock review хийнэ.

2026-09-15 шинэчлэлт: public candidate нийтлэл ба PostgreSQL/restore CI-г
хэрэглэгч зөвшөөрсөн; [одоогийн review](72-remaining-work-review.md).
