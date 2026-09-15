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

Chromium partial/rollback suite: 3 үйлдэл, lost-response retry-тай 5 API model
хүсэлт. 10 partial rollback acceptance тест болон batch cancellation-ийн шинэ
тохиолдол PostgreSQL-д давсан. [Нийт 934 skip-free тестийн acceptance](73-remaining-modules-acceptance.md).
Migration 074 бодит PostgreSQL-д хэрэгжиж, RLS/trigger/locking guard-ууд шалгагдсан.

Batch-ийн үлдсэн ажлыг цуцлахад хэсэгчилсэн хүүхэд хүсэлт ROLLBACK_REQUIRED,
хөдөлгөөнгүй нь CANCELLED болно. Давтан цуцлалт нээлттэй буцаалтын ажлыг
алга болгохгүй. Partial movement-ийн дараа анхны хуучирсан тооллогод шинэ
variance decision нэмж болохгүй; буцаалт болон шалтгаантай stock review хийнэ.
